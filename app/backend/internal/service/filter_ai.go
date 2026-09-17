package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode"

	"gist/backend/internal/model"
	"gist/backend/internal/service/ai"
	"gist/backend/pkg/logger"
)

// AI 条件（P3）与自然语言建规则共用的成本护栏。
//
// 判定是整条规则链里唯一「按条花钱」的地方，所以刻意做成：宁可漏判并把原因写在规则的
// last_error 上，也不让一次刷新把钱包掏空。
//   - 正文短于 aiJudgeMinChars：不值得问模型（按「不命中」处理并计数）
//   - 单次运行（一次入库批次）最多新发起 aiJudgeMaxCallsPerRun 次判定（吃缓存的不算）
//   - 进程内滑动窗口 aiJudgeWindow 内最多 aiJudgeMaxCallsPerWindow 次
const (
	aiJudgeMinChars          = 400
	aiJudgeMaxCallsPerRun    = 5
	aiJudgeMaxCallsPerWindow = 60
	aiJudgeWindow            = 10 * time.Minute
	aiJudgeTimeout           = 20 * time.Second
	aiJudgeMaxContentRunes   = 2000
)

// AICompleter 过滤器侧需要的 AI 能力：一段补全 + 当前模型名。
// 由 AIService 实现（见 ai_service.go 的 Complete / ModelName）。
type AICompleter interface {
	Complete(ctx context.Context, systemPrompt, content string) (string, error)
	ModelName(ctx context.Context) string
}

// aiJudgeGovernor 进程内滑动窗口限速。刻意不做成全局变量（项目规矩：依赖注入，不要全局状态），
// 由 NewFilterService 建一个、随服务实例存活。
type aiJudgeGovernor struct {
	mu     sync.Mutex
	window []time.Time
}

func (g *aiJudgeGovernor) allow(now time.Time) bool {
	g.mu.Lock()
	defer g.mu.Unlock()

	cutoff := now.Add(-aiJudgeWindow)
	kept := make([]time.Time, 0, len(g.window)+1)
	for _, stamp := range g.window {
		if stamp.After(cutoff) {
			kept = append(kept, stamp)
		}
	}
	g.window = kept

	if len(g.window) >= aiJudgeMaxCallsPerWindow {
		return false
	}
	g.window = append(g.window, now)
	return true
}

// aiJudgeBudget 一次运行（一次入库批次 / 一次回溯）共享的 AI 判定额度。
// 之所以共享：额度是「这一轮最多问几次模型」的成本护栏，不该按规则条数翻倍。
type aiJudgeBudget struct {
	mu        sync.Mutex
	remaining int
}

func newAIJudgeBudget() *aiJudgeBudget {
	return &aiJudgeBudget{remaining: aiJudgeMaxCallsPerRun}
}

func (b *aiJudgeBudget) take(now time.Time, governor *aiJudgeGovernor) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.remaining <= 0 {
		return false
	}
	if governor != nil && !governor.allow(now) {
		return false
	}
	b.remaining--
	return true
}

// aiJudgeRun 一次规则执行内的 AI 判定状态：**按规则**统计跳过与失败（原因要写回正确的规则）。
type aiJudgeRun struct {
	service   *filterService
	ctx       context.Context
	budget    *aiJudgeBudget
	cacheOnly bool
	short     int
	limited   int
	failures  []string
}

func (s *filterService) newAIJudgeRun(ctx context.Context, budget *aiJudgeBudget, cacheOnly bool) *aiJudgeRun {
	if budget == nil {
		budget = newAIJudgeBudget()
	}
	return &aiJudgeRun{service: s, ctx: ctx, budget: budget, cacheOnly: cacheOnly}
}

// verdict 取「这条内容与这个主题是否相关」。
// ok=false 表示这次没判成（未配置 / 调用失败 / 正文过短 / 额度用尽 / 预览只吃缓存）——
// 调用方按「不命中」处理，并把原因写进规则的 last_error，绝不静默吞掉。
func (r *aiJudgeRun) verdict(entry EntryContext, question string) (bool, bool) {
	question = strings.TrimSpace(question)
	if r == nil || r.service == nil || question == "" {
		return false, false
	}
	if r.service.ai == nil {
		r.record("AI 未配置：先在 设置 → AI 里填好 provider / API key / model")
		return false, false
	}

	hash := questionHash(question)
	if entry.ID > 0 {
		cached, found, err := r.service.filters.GetAIJudgement(r.ctx, entry.ID, hash)
		if err == nil && found {
			return cached, true
		}
		if err != nil {
			r.record("读取 AI 判定缓存失败：" + err.Error())
			return false, false
		}
	}

	text := judgeContent(entry)
	if len([]rune(text)) < aiJudgeMinChars {
		r.short++
		return false, false
	}
	if r.cacheOnly {
		r.short++
		return false, false
	}

	now := time.Now()
	if r.budget == nil || !r.budget.take(now, r.service.governor) {
		r.limited++
		return false, false
	}

	callCtx, cancel := context.WithTimeout(r.ctx, aiJudgeTimeout)
	defer cancel()
	raw, err := r.service.ai.Complete(callCtx, ai.GetRelevanceJudgePrompt(question), ai.WrapInput(text))
	if err != nil {
		r.record("AI 判定调用失败：" + err.Error())
		return false, false
	}
	answer, ok := parseRelevanceAnswer(raw)
	if !ok {
		r.record("AI 判定无法解析（模型回答：" + truncateRunes(strings.TrimSpace(raw), 40) + "）")
		return false, false
	}

	if entry.ID > 0 {
		if err := r.service.filters.SaveAIJudgement(r.ctx, entry.ID, hash, answer, r.service.ai.ModelName(r.ctx), now); err != nil {
			logger.Warn("save ai judgement failed", "module", "service", "action", "save", "resource", "filter", "result", "failed", "entry_id", entry.ID, "error", err)
		}
	}
	return answer, true
}

func (r *aiJudgeRun) record(message string) {
	r.limited++
	if len(r.failures) >= 3 || containsString(r.failures, message) {
		return
	}
	r.failures = append(r.failures, message)
}

// message 把这一轮的原因合成一句话（写进规则的 last_error）；没问题时返回空串。
func (r *aiJudgeRun) message() string {
	if r == nil {
		return ""
	}
	parts := append([]string{}, r.failures...)
	if r.short > 0 {
		parts = append(parts, fmt.Sprintf("%d 条正文短于 %d 字，未做 AI 判定", r.short, aiJudgeMinChars))
	}
	if r.limited > 0 {
		parts = append(parts, fmt.Sprintf("%d 条达到本次 AI 判定上限（单次 %d 次 / 10 分钟 %d 次），留到下次", r.limited, aiJudgeMaxCallsPerRun, aiJudgeMaxCallsPerWindow))
	}
	return strings.Join(parts, "；")
}

// questionHash 判定缓存的键：同一个主题描述只问一次。
func questionHash(question string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(question)))
	return hex.EncodeToString(sum[:])
}

// judgeContent 送给模型的正文：标题 + 去标签的正文，按 rune 截断。
func judgeContent(entry EntryContext) string {
	title := strings.TrimSpace(entry.Title)
	body := strings.TrimSpace(ai.HTMLToText(entry.Content))
	if body == "" {
		body = strings.TrimSpace(entry.Author)
	}
	combined := title
	if body != "" {
		combined = title + "\n\n" + body
	}
	return truncateRunes(strings.TrimSpace(combined), aiJudgeMaxContentRunes)
}

// parseRelevanceAnswer 解析模型的 YES / NO。解析不出来就返回 ok=false（不猜）。
func parseRelevanceAnswer(raw string) (bool, bool) {
	value := strings.ToUpper(strings.TrimSpace(raw))
	value = strings.Trim(value, " \t\n\r.。！!*\"'`「」")
	if strings.HasPrefix(value, "YES") {
		return true, true
	}
	if strings.HasPrefix(value, "NO") {
		return false, true
	}
	if containsWord(value, "YES") {
		return true, true
	}
	if containsWord(value, "NO") {
		return false, true
	}
	return false, false
}

func containsWord(value, word string) bool {
	tokens := strings.FieldsFunc(value, func(r rune) bool {
		return !unicode.IsLetter(r)
	})
	for _, token := range tokens {
		if token == word {
			return true
		}
	}
	return false
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit]) + "…"
}

// —— 自然语言建规则 ——

// FilterDraft 自然语言建规则的结果：一份能直接填进编辑器抽屉的草稿（不落库、由用户确认）。
type FilterDraft struct {
	Name       string
	ScopeType  string
	ScopeID    *int64
	Conditions []model.FilterCondition
	Actions    model.FilterActions
	// Notes 模型给出的一句话解释（编辑器里显示，帮用户判断它理解对没有）
	Notes string
	// Warnings 出结果前被修正/丢弃的东西（例如模型编了一个不存在的订阅 id）——
	// 有内容就必须在界面上显示出来，不能悄悄改。
	Warnings []string
}

// filterDraftPayload 模型输出的形状。scopeId 可能是字符串也可能是数字，先宽松收下再严格校验。
type filterDraftPayload struct {
	Name       string                  `json:"name"`
	ScopeType  string                  `json:"scopeType"`
	ScopeID    json.RawMessage         `json:"scopeId"`
	Conditions []model.FilterCondition `json:"conditions"`
	Actions    model.FilterActions     `json:"actions"`
	Notes      string                  `json:"notes"`
	WebhookURL string                  `json:"webhookUrl"`
}

// parseFilterDraft 把模型输出解析成草稿（认 fenced code block、认多余的客套话），
// 解析不出来的字段一律留空并由调用方校验 —— 模型说了不算。
func parseFilterDraft(raw string) (FilterDraft, error) {
	jsonText := extractJSONObject(raw)
	if jsonText == "" {
		return FilterDraft{}, fmt.Errorf("no json object in model output")
	}

	var payload filterDraftPayload
	if err := json.Unmarshal([]byte(jsonText), &payload); err != nil {
		return FilterDraft{}, fmt.Errorf("unmarshal draft: %w", err)
	}

	draft := FilterDraft{
		Name:       strings.TrimSpace(payload.Name),
		ScopeType:  strings.TrimSpace(payload.ScopeType),
		Conditions: payload.Conditions,
		Actions:    payload.Actions,
		Notes:      strings.TrimSpace(payload.Notes),
	}
	if draft.Actions.WebhookURL == "" {
		draft.Actions.WebhookURL = strings.TrimSpace(payload.WebhookURL)
	}
	if draft.Name == "" {
		draft.Name = "AI 规则"
	}
	if draft.ScopeType == "" {
		draft.ScopeType = model.FilterScopeAll
	}
	if draft.ScopeType == model.FilterScopeAll {
		draft.ScopeID = nil
	} else if id, ok := parseRawID(payload.ScopeID); ok {
		draft.ScopeID = &id
	}
	for index := range draft.Conditions {
		draft.Conditions[index].Field = strings.TrimSpace(draft.Conditions[index].Field)
		draft.Conditions[index].Operator = strings.TrimSpace(draft.Conditions[index].Operator)
		draft.Conditions[index].Value = strings.TrimSpace(draft.Conditions[index].Value)
		draft.Conditions[index].Logic = strings.TrimSpace(draft.Conditions[index].Logic)
		if draft.Conditions[index].Logic == "" {
			draft.Conditions[index].Logic = "and"
		}
	}
	if draft.Conditions == nil {
		draft.Conditions = []model.FilterCondition{}
	}
	return draft, nil
}

// extractJSONObject 从模型输出里抠出第一个完整 JSON 对象（容忍 ```json 围栏与前后废话）。
func extractJSONObject(raw string) string {
	text := strings.TrimSpace(raw)
	if fence := strings.Index(text, "```"); fence >= 0 {
		rest := text[fence+3:]
		if newline := strings.IndexByte(rest, '\n'); newline >= 0 {
			rest = rest[newline+1:]
		}
		if end := strings.Index(rest, "```"); end >= 0 {
			text = rest[:end]
		} else {
			text = rest
		}
		text = strings.TrimSpace(text)
	}
	start := strings.IndexByte(text, '{')
	end := strings.LastIndexByte(text, '}')
	if start < 0 || end <= start {
		return ""
	}
	return text[start : end+1]
}

// parseRawID 宽松解析 scopeId：字符串 "123"、数字 123 都收。
func parseRawID(raw json.RawMessage) (int64, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		trimmed := strings.TrimSpace(asString)
		if trimmed == "" || trimmed == "null" {
			return 0, false
		}
		var id int64
		if _, err := fmt.Sscanf(trimmed, "%d", &id); err != nil || id <= 0 {
			return 0, false
		}
		return id, true
	}
	var asNumber int64
	if err := json.Unmarshal(raw, &asNumber); err == nil && asNumber > 0 {
		return asNumber, true
	}
	return 0, false
}
