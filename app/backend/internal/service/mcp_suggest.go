package service

// 第 4 档 AI 兜底映射（16-3）：只有纯文本、且文本不是 JSON 时，才走这条路。
//
// 流程：inspect 判定 tier=text → 界面显黄条「用 AI 猜一次映射」→ 后端把样本 +
// 四个目标字段喂给已配的 AI provider，**一次调用**要回 JSON 路径 → 猜出来的映射
// 只返回、不落库 —— **必须预览确认后才落库**（落库发生在用户点「创建订阅」那一刻，
// 走的还是原来那条 BuildMCPFeedConfig，AI 建议本身不写任何东西）。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"krss/backend/internal/model"
)

// MCPSuggestRequest AI 猜映射的入参（复用 inspect 的取数参数）。
type MCPSuggestRequest struct {
	Kind        string
	ToolName    string
	ResourceURI string
	Arguments   map[string]any
	Limit       int
}

// MCPSuggestResult AI 猜出来的映射（只返回，不落库）。
type MCPSuggestResult struct {
	Mapping model.MCPFieldMapping `json:"mapping"`
	Model   string                `json:"model"`
	// EstimatedTokens 粗估的消耗（字符数/4，标「约」—— provider 没回真实用量）。
	EstimatedTokens int    `json:"estimatedTokens"`
	TextUsed        int    `json:"textUsed"`
	Raw             string `json:"raw,omitempty"`
}

// suggestSampleMaxLen 喂给 AI 的样本上限（4000 字符：够看形状，不烧 token）。
const suggestSampleMaxLen = 4000

// SuggestMapping 调一次 AI 猜映射。ai 没配 → 明确报错（界面退回手动路径输入）。
func (s *mcpService) SuggestMapping(ctx context.Context, id int64, req MCPSuggestRequest) (MCPSuggestResult, error) {
	if s.ai == nil {
		return MCPSuggestResult{}, fmt.Errorf("%w: AI 未配置，请先去「设置 → AI」配好 provider，或手动指定字段路径", ErrMCPInvalid)
	}
	server, err := s.servers.GetByID(ctx, id)
	if err != nil {
		return MCPSuggestResult{}, err
	}
	client, err := s.newClient(ctx, server)
	if err != nil {
		s.markStatus(ctx, server, err, server.ToolCount, server.ResourceCount)
		return MCPSuggestResult{}, err
	}
	defer client.Close()

	inspectReq := MCPInspectRequest{Kind: req.Kind, ToolName: req.ToolName, ResourceURI: req.ResourceURI, Arguments: req.Arguments, Limit: req.Limit}
	payload, inference, err := s.samplePayload(ctx, client, inspectReq)
	if err != nil {
		return MCPSuggestResult{}, err
	}
	if inference.Tier != model.MCPTierText {
		return MCPSuggestResult{}, fmt.Errorf("%w: 这档（%s）已经能自动映射，不需要 AI 猜", ErrMCPInvalid, inference.Tier)
	}
	text, ok := payload.(string)
	if !ok || strings.TrimSpace(text) == "" {
		return MCPSuggestResult{}, fmt.Errorf("%w: 没有可供 AI 看的文本样本", ErrMCPInvalid)
	}
	sample := truncateRunesForSuggest(text, suggestSampleMaxLen)
	system, user := buildSuggestPrompt(sample)
	answer, err := s.ai.Complete(ctx, system, user)
	if err != nil {
		return MCPSuggestResult{}, err
	}
	mapping, err := parseSuggestAnswer(answer)
	if err != nil {
		return MCPSuggestResult{}, fmt.Errorf("AI 回的不是合法映射 JSON（%v），请手动指定字段路径", err)
	}
	modelName := ""
	if s.ai != nil {
		modelName = s.ai.ModelName(ctx)
	}
	return MCPSuggestResult{
		Mapping:         mapping,
		Model:           modelName,
		EstimatedTokens: (utf8.RuneCountInString(system) + utf8.RuneCountInString(user) + utf8.RuneCountInString(answer)) / 4,
		TextUsed:        utf8.RuneCountInString(sample),
	}, nil
}

// buildSuggestPrompt 组装喂给 AI 的 system + user（纯函数，单测钉住格式）。
// 四个目标字段：标题 / 链接 / 正文 / 时间（另可带 id 去重键与 listPath）。
func buildSuggestPrompt(sample string) (system, user string) {
	system = "你是一个 MCP 返回解析助手。用户会给你一段 MCP 工具返回的纯文本样本，" +
		"请从中找出「多条并列条目」的切分方式，并用 JSON 路径（点号表示，如 items.0.title，纯文本用 section 索引如 sections.2）" +
		"描述四个目标字段。只返回一个 JSON 对象，不要解释，不要 markdown 包裹。\n" +
		"键固定为：listPath（条目数组的路径，没有数组填空字符串）、title（标题字段）、url（链接字段，没有填空字符串）、" +
		"content（正文字段）、publishedAt（时间字段，没有填空字符串）、id（去重键字段，没有填空字符串）。"
	user = "样本如下：\n" + sample
	return system, user
}

// parseSuggestAnswer 从 AI 回答里抠映射 JSON（容忍 ```json 包裹与前后杂话）。
func parseSuggestAnswer(answer string) (model.MCPFieldMapping, error) {
	text := strings.TrimSpace(answer)
	if strings.HasPrefix(text, "```") {
		lines := strings.Split(text, "\n")
		var kept []string
		inBlock := false
		for _, line := range lines {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "```") {
				inBlock = !inBlock
				continue
			}
			if inBlock || (!strings.HasPrefix(trimmed, "```") && len(lines) == 1) {
				kept = append(kept, line)
			}
		}
		if len(kept) > 0 {
			text = strings.Join(kept, "\n")
		}
	}
	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start < 0 || end <= start {
		return model.MCPFieldMapping{}, errors.New("找不到 JSON 对象")
	}
	var raw struct {
		ListPath    string `json:"listPath"`
		Title       string `json:"title"`
		URL         string `json:"url"`
		Content     string `json:"content"`
		PublishedAt string `json:"publishedAt"`
		ID          string `json:"id"`
	}
	if err := json.Unmarshal([]byte(text[start:end+1]), &raw); err != nil {
		return model.MCPFieldMapping{}, err
	}
	if strings.TrimSpace(raw.Title) == "" && strings.TrimSpace(raw.Content) == "" {
		return model.MCPFieldMapping{}, errors.New("标题与正文路径都为空，没法用")
	}
	return model.MCPFieldMapping{
		ListPath:    strings.TrimSpace(raw.ListPath),
		Title:       strings.TrimSpace(raw.Title),
		URL:         strings.TrimSpace(raw.URL),
		Content:     strings.TrimSpace(raw.Content),
		PublishedAt: strings.TrimSpace(raw.PublishedAt),
		ID:          strings.TrimSpace(raw.ID),
	}, nil
}

func truncateRunesForSuggest(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	runes := []rune(s)
	return string(runes[:max]) + "…（样本过长已截断）"
}
