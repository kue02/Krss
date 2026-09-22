package mcp

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"krss/backend/internal/model"
)

// ---------------------------------------------------------------------------
// 映射引擎（16-3 核心）：MCP 的返回值没有固定形状，而条目有固定形状，
// 中间要有一层「声明式字段路径」映射。按返回形态分四档自动预填：
//   ① resource / resource_link（带 uri）—— 几乎零映射
//   ② 有 outputSchema              —— 读 schema 直接生成
//   ③ 有结构化 JSON（structuredContent / JSON 文本）无 schema —— 按常见字段名预填
//   ④ 只有纯文本                    —— 先当 JSON 解析，再退 Markdown 切分，最后人工（AI 兜底留 P2）
// ---------------------------------------------------------------------------

// Item 一条候选条目（映射的产物）。上层再把它转成 gofeed.Item 走既有 saveEntries 管道。
type Item struct {
	Title       string
	URL         string
	Content     string
	PublishedAt string
	Author      string
	Thumbnail   string
	// Key 去重键的实际取值；KeyLevel 是「用了哪一级」（界面只显示它）。
	Key      string
	KeyLevel string
}

// Inference 推断结果：档位 + 自动预填的映射 + 备注（给界面解释「为什么这么填」）。
type Inference struct {
	Tier    string
	Mapping model.MCPFieldMapping
	Notes   []string
	// Keys 前几条算出来的去重键（预览里显示，键选错一眼可见）。
	Keys []string
}

var (
	titleCandidates   = []string{"title", "name", "subject", "headline", "display_name", "heading", "summary_title"}
	urlCandidates     = []string{"url", "link", "href", "web_url", "permalink", "source_url", "external_url", "html_url", "source"}
	contentCandidates = []string{"content", "body", "text", "description", "summary", "markdown", "snippet", "abstract", "html", "note"}
	dateCandidates    = []string{"published_at", "publishedAt", "published", "created_at", "createdAt", "created", "updated_at", "updatedAt", "updated", "date", "datetime", "timestamp", "time", "lastModified", "modified"}
	authorCandidates  = []string{"author", "authors", "by", "creator", "username", "user", "owner", "from"}
	idCandidates      = []string{"id", "_id", "key", "slug", "guid", "uuid", "uid", "objectID", "identifier", "url"}
	thumbCandidates   = []string{"thumbnail", "thumbnail_url", "image", "image_url", "cover", "cover_url", "picture"}
	listKeyCandidates = []string{"items", "data", "results", "entries", "records", "list", "notes", "children", "rows", "documents", "nodes", "posts"}
)

// InferFromToolResult 从 tools/call 的结果推断映射（第 ①~④ 档）。
func InferFromToolResult(result CallToolResult, outputSchema json.RawMessage) (Inference, error) {
	// ① resource / resource_link：规范化成 {name, uri, text} 的列表
	if _, ok := ResourceContentsToItems(result.Content); ok {
		return Inference{
			Tier: model.MCPTierResource,
			Mapping: model.MCPFieldMapping{
				Title:   "name",
				URL:     "uri",
				Content: "text",
			},
			Notes: []string{"返回的是资源（带 uri），标题/链接/正文可直接对上，无需人工映射"},
		}, nil
	}

	// ② 有 outputSchema：直接读 schema
	if len(outputSchema) > 0 {
		if inf, ok := inferFromSchema(outputSchema); ok {
			return inf, nil
		}
	}

	// ③ structuredContent / JSON 文本
	var payload any
	if len(result.StructuredContent) > 0 {
		if err := json.Unmarshal(result.StructuredContent, &payload); err != nil {
			return Inference{}, fmt.Errorf("解析 structuredContent 失败: %w", err)
		}
		return inferFromPayload(payload, model.MCPTierStructured), nil
	}

	text := firstText(result.Content)
	if strings.TrimSpace(text) == "" {
		// 图片 / 音频那类内容没法变成条目 —— 明确报错，不静默出空条目
		for _, c := range result.Content {
			if c.Type != "" && c.Type != "text" {
				return Inference{}, fmt.Errorf("工具只返回了 %s 内容，没法映射成条目（第一版不支持）", c.Type)
			}
		}
		return Inference{}, fmt.Errorf("工具返回里没有可用内容（content 为空）")
	}
	// 规范本来就建议「结构化内容同时序列化进一个 text」—— 先试着当 JSON 解
	var fromText any
	if err := json.Unmarshal([]byte(text), &fromText); err == nil {
		return inferFromPayload(fromText, model.MCPTierStructured), nil
	}

	// ④ 纯文本且不是 JSON：退 Markdown 切分
	inf := Inference{
		Tier: model.MCPTierText,
		Mapping: model.MCPFieldMapping{
			Title:   "title",
			Content: "content",
		},
		Notes: []string{"纯文本（不是 JSON）：按 Markdown 标题/列表切分；切不出来就要人工指字段"},
	}
	if _, ok := splitText(text); !ok {
		return inf, fmt.Errorf("纯文本且切不出结构：需要人工指定字段路径（AI 兜底映射留 P2）")
	}
	return inf, nil
}

// InferFromResourceContents 从 resources/read 的结果推断映射（都是第 ① 档）。
func InferFromResourceContents(contents []ResourceContent) (Inference, error) {
	if len(contents) == 0 {
		return Inference{}, fmt.Errorf("资源内容为空")
	}
	text := ""
	for _, c := range contents {
		if strings.TrimSpace(c.Text) != "" {
			text = c.Text
			break
		}
	}
	if strings.TrimSpace(text) == "" {
		return Inference{}, fmt.Errorf("资源只给了二进制内容（blob），没法映射成条目")
	}
	var payload any
	if err := json.Unmarshal([]byte(text), &payload); err == nil {
		return inferFromPayload(payload, model.MCPTierStructured), nil
	}
	inf := Inference{
		Tier: model.MCPTierText,
		Mapping: model.MCPFieldMapping{
			Title:   "title",
			Content: "content",
		},
		Notes: []string{"资源是纯文本：按 Markdown 标题切分"},
	}
	if _, ok := splitText(text); !ok {
		return inf, fmt.Errorf("资源是纯文本且切不出结构：需要人工指定字段路径")
	}
	return inf, nil
}

// ResourceContentsToItems 把 resource / resource_link 内容的集合规范化成「列表」：
// 每项 {name, uri, text, mimeType} —— 第 ① 档的映射（title=name / url=uri / content=text）
// 直接就能用，也供上层从工具结果里取「可映射的 payload」。
// 只有「全是资源类内容」时才算命中第 ① 档。
func ResourceContentsToItems(contents []Content) ([]map[string]any, bool) {
	if len(contents) == 0 {
		return nil, false
	}
	items := make([]map[string]any, 0, len(contents))
	for _, content := range contents {
		switch content.Type {
		case "resource_link":
			items = append(items, map[string]any{
				"name": firstNonEmpty(content.Name, content.URI),
				"uri":  content.URI,
				"text": "",
			})
		case "resource":
			if content.Resource == nil {
				return nil, false
			}
			item := map[string]any{
				"name": firstNonEmpty(content.Resource.Title, content.Resource.Name, content.Resource.URI),
				"uri":  content.Resource.URI,
				"text": firstNonEmpty(content.Text, content.Data),
			}
			if content.Resource.MimeType != "" {
				item["mimeType"] = content.Resource.MimeType
			}
			items = append(items, item)
		default:
			return nil, false
		}
	}
	return items, len(items) > 0
}

// inferFromSchema 读 outputSchema：找数组属性当列表路径，再按属性名映射字段（第 ② 档）。
func inferFromSchema(schema json.RawMessage) (Inference, bool) {
	var root map[string]any
	if err := json.Unmarshal(schema, &root); err != nil {
		return Inference{}, false
	}
	listPath, props, ok := findArrayInSchema(root, "")
	if !ok {
		// schema 直接描述单个对象：当成单条
		if p, ok := schemaProperties(root); ok {
			mapping := mappingFromPropertyNames(keysOf(p))
			return Inference{
				Tier:    model.MCPTierSchema,
				Mapping: mapping,
				Notes:   []string{"工具声明了 outputSchema（单对象）：字段按 schema 推断"},
			}, true
		}
		return Inference{}, false
	}
	mapping := mappingFromPropertyNames(keysOf(props))
	mapping.ListPath = listPath
	if len(props) == 0 {
		return Inference{}, false
	}
	return Inference{
		Tier:    model.MCPTierSchema,
		Mapping: mapping,
		Notes:   []string{"工具声明了 outputSchema：列表路径与字段都由 schema 直接生成"},
	}, true
}

// findArrayInSchema 递归找「数组」属性。返回点号路径 + 数组元素的 properties。
func findArrayInSchema(node map[string]any, prefix string) (string, map[string]any, bool) {
	if t, _ := node["type"].(string); t == "array" {
		items, _ := node["items"].(map[string]any)
		props, _ := schemaProperties(items)
		return prefix, props, true
	}
	props, ok := schemaProperties(node)
	if !ok {
		return "", nil, false
	}
	names := make([]string, 0, len(props))
	for name := range props {
		names = append(names, name)
	}
	sort.Strings(names)
	// 先试常见列表键名，再退「任意数组属性」
	for _, want := range listKeyCandidates {
		if child, ok := props[want].(map[string]any); ok {
			path := joinPath(prefix, want)
			if _, p, ok := findArrayInSchema(child, path); ok {
				return path, p, true
			}
		}
	}
	for _, name := range names {
		child, ok := props[name].(map[string]any)
		if !ok {
			continue
		}
		path := joinPath(prefix, name)
		if _, p, ok := findArrayInSchema(child, path); ok {
			return path, p, true
		}
	}
	return "", nil, false
}

func schemaProperties(node map[string]any) (map[string]any, bool) {
	raw, ok := node["properties"]
	if !ok {
		return nil, false
	}
	props, ok := raw.(map[string]any)
	if !ok {
		return nil, false
	}
	return props, true
}

func keysOf(props map[string]any) []string {
	out := make([]string, 0, len(props))
	for name := range props {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// inferFromPayload 从解析好的 JSON 里找列表 + 按字段名预填（第 ③ 档）。
func inferFromPayload(payload any, tier string) Inference {
	listPath, list := findList(payload, "")
	mapping := model.MCPFieldMapping{ListPath: listPath}
	notes := []string{}
	if listPath == "" {
		notes = append(notes, "结果本身就是数组")
	} else {
		notes = append(notes, "列表路径自动识别为 "+listPath)
	}

	// 用一个「代表样本」的键集合来预填字段路径
	var sample map[string]any
	for _, element := range list {
		if m, ok := element.(map[string]any); ok {
			sample = m
			break
		}
	}
	if sample == nil && listPath == "" {
		if m, ok := payload.(map[string]any); ok {
			sample = m
		}
	}
	if sample != nil {
		prefix := ""
		mapping.Title = pickField(sample, titleCandidates, "")
		mapping.URL = pickField(sample, urlCandidates, "")
		mapping.Content = pickField(sample, contentCandidates, "")
		mapping.PublishedAt = pickField(sample, dateCandidates, "")
		mapping.Author = pickField(sample, authorCandidates, "")
		mapping.ID = pickIDField(list, idCandidates)
		mapping.Thumbnail = pickField(sample, thumbCandidates, "")
		_ = prefix
	}
	if mapping.Title == "" && mapping.Content == "" {
		notes = append(notes, "没认出标题/正文字段：请人工指一下路径")
	}
	return Inference{Tier: tier, Mapping: mapping, Notes: notes}
}

// findList 递归找「元素对象最多的数组」。返回点号路径（顶层数组返回 ""）。
func findList(node any, path string) (string, []any) {
	if arr, ok := node.([]any); ok {
		return path, arr
	}
	obj, ok := node.(map[string]any)
	if !ok {
		return "", nil
	}
	// 先试常见列表键名
	for _, want := range listKeyCandidates {
		if child, ok := obj[want]; ok {
			if arr, ok := child.([]any); ok && len(arr) > 0 {
				return joinPath(path, want), arr
			}
		}
	}
	// 再退「对象元素最多的那个数组」
	names := make([]string, 0, len(obj))
	for name := range obj {
		names = append(names, name)
	}
	sort.Strings(names)
	bestPath := ""
	var best []any
	bestScore := -1
	for _, name := range names {
		child := obj[name]
		arr, ok := child.([]any)
		if !ok || len(arr) == 0 {
			continue
		}
		score := 0
		for _, element := range arr {
			if _, ok := element.(map[string]any); ok {
				score++
			}
		}
		if score > bestScore {
			bestScore = score
			best = arr
			bestPath = joinPath(path, name)
		}
	}
	if best != nil {
		return bestPath, best
	}
	// 深层再找一层
	for _, name := range names {
		child := obj[name]
		if _, ok := child.(map[string]any); !ok {
			continue
		}
		if p, arr := findList(child, joinPath(path, name)); arr != nil {
			return p, arr
		}
	}
	return "", nil
}

// mappingFromPropertyNames 按字段名给一份映射（② 档用）。
func mappingFromPropertyNames(names []string) model.MCPFieldMapping {
	sample := map[string]any{}
	for _, name := range names {
		sample[name] = nil
	}
	mapping := model.MCPFieldMapping{
		Title:       pickField(sample, titleCandidates, ""),
		URL:         pickField(sample, urlCandidates, ""),
		Content:     pickField(sample, contentCandidates, ""),
		PublishedAt: pickField(sample, dateCandidates, ""),
		Author:      pickField(sample, authorCandidates, ""),
		Thumbnail:   pickField(sample, thumbCandidates, ""),
	}
	for _, want := range idCandidates {
		for _, name := range names {
			if strings.EqualFold(name, want) {
				mapping.ID = name
				break
			}
		}
		if mapping.ID != "" {
			break
		}
	}
	return mapping
}

// pickField 在样本里按候选名找字段路径；name/url/text 这类子键会下探一层。
func pickField(sample map[string]any, candidates []string, prefix string) string {
	for _, want := range candidates {
		for key, value := range sample {
			if !strings.EqualFold(key, want) {
				continue
			}
			path := joinPath(prefix, key)
			// 值是对象时下探常见子键（author: {name: ...}）
			if child, ok := value.(map[string]any); ok {
				for _, sub := range []string{"name", "title", "url", "link", "text", "href"} {
					for subKey := range child {
						if strings.EqualFold(subKey, sub) {
							return joinPath(path, subKey)
						}
					}
				}
			}
			return path
		}
	}
	return ""
}

// pickIDField 选去重键字段：优先「值唯一」的 id/key/slug 类字段，其次 url/link。
func pickIDField(list []any, candidates []string) string {
	if len(list) == 0 {
		return ""
	}
	score := func(slot string) int {
		seen := map[string]int{}
		total := 0
		for _, element := range list {
			obj, ok := element.(map[string]any)
			if !ok {
				continue
			}
			value, ok := lookupCaseInsensitive(obj, slot)
			if !ok {
				continue
			}
			text := scalarToString(value)
			if text == "" {
				continue
			}
			total++
			seen[text]++
		}
		if total == 0 {
			return -1
		}
		if len(seen) == total {
			return total // 全都唯一
		}
		return 0
	}
	best := ""
	bestScore := -1
	for _, want := range candidates {
		for key := range list[0].(map[string]any) {
			if !strings.EqualFold(key, want) {
				continue
			}
			if s := score(key); s > bestScore {
				bestScore = s
				best = key
			}
		}
	}
	if bestScore <= 0 {
		return ""
	}
	return best
}

// ---------------------------------------------------------------------------
// 取值 / 组装
// ---------------------------------------------------------------------------

// Lookup 点号路径取值，支持 a.b.c 与 a[0].b / a.0.b。
func Lookup(root any, path string) (any, bool) {
	path = strings.TrimSpace(path)
	if path == "" {
		return root, true
	}
	current := root
	for _, segment := range strings.Split(path, ".") {
		segment = strings.TrimSpace(segment)
		if segment == "" {
			continue
		}
		// 下标段：items[0] / entries[0][1] / [0]
		if open := strings.Index(segment, "["); open >= 0 && strings.HasSuffix(segment, "]") {
			field := segment[:open]
			if field != "" {
				obj, ok := current.(map[string]any)
				if !ok {
					return nil, false
				}
				value, ok := lookupCaseInsensitive(obj, field)
				if !ok {
					return nil, false
				}
				current = value
			}
			for _, raw := range strings.Split(strings.TrimSuffix(segment[open:], "]"), "[") {
				if raw == "" {
					continue
				}
				index, err := strconv.Atoi(raw)
				if err != nil {
					return nil, false
				}
				arr, ok := current.([]any)
				if !ok {
					return nil, false
				}
				if index < 0 || index >= len(arr) {
					return nil, false
				}
				current = arr[index]
			}
			continue
		}
		// 纯数字段名当数组下标（a.0.b）
		if index, err := strconv.Atoi(segment); err == nil {
			if arr, ok := current.([]any); ok {
				if index < 0 || index >= len(arr) {
					return nil, false
				}
				current = arr[index]
				continue
			}
		}
		obj, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		value, ok := lookupCaseInsensitive(obj, segment)
		if !ok {
			return nil, false
		}
		current = value
	}
	return current, true
}

func lookupCaseInsensitive(obj map[string]any, key string) (any, bool) {
	if value, ok := obj[key]; ok {
		return value, true
	}
	for name, value := range obj {
		if strings.EqualFold(name, key) {
			return value, true
		}
	}
	return nil, false
}

// ExtractList 按映射（或自动识别）取出候选列表。
func ExtractList(payload any, mapping model.MCPFieldMapping) ([]any, error) {
	if strings.TrimSpace(mapping.ListPath) != "" {
		value, ok := Lookup(payload, mapping.ListPath)
		if !ok {
			return nil, fmt.Errorf("列表路径 %q 在返回结果里取不到值", mapping.ListPath)
		}
		arr, ok := value.([]any)
		if !ok {
			return nil, fmt.Errorf("列表路径 %q 指向的不是数组", mapping.ListPath)
		}
		return arr, nil
	}
	if arr, ok := payload.([]any); ok {
		return arr, nil
	}
	if _, arr := findList(payload, ""); arr != nil {
		return arr, nil
	}
	// 单对象：当成只有一条
	if _, ok := payload.(map[string]any); ok {
		return []any{payload}, nil
	}
	return nil, fmt.Errorf("结果里没有列表，也没有对象可当单条处理（映射里的「列表路径」需要人工指）")
}

// BuildItems 按映射把返回结果变成候选条目。返回的第一条错误就是「映射失败」的原因，
// 上层要把它写进该源的 last_error —— 不许静默出空条目。
func BuildItems(payload any, tier string, mapping model.MCPFieldMapping) ([]Item, error) {
	if tier == model.MCPTierText {
		text := ""
		switch v := payload.(type) {
		case string:
			text = v
		case []ResourceContent:
			if len(v) > 0 {
				text = v[0].Text
			}
		default:
			if s := firstTextFromAny(payload); s != "" {
				text = s
			}
		}
		sections, ok := splitText(text)
		if !ok {
			return nil, fmt.Errorf("纯文本切不出结构：请人工指定字段路径")
		}
		items := make([]Item, 0, len(sections))
		for _, section := range sections {
			item := Item{Title: section.Title, Content: section.Content}
			item.Key, item.KeyLevel = degradeKey(item, mapping)
			items = append(items, item)
		}
		return items, nil
	}

	list, err := ExtractList(payload, mapping)
	if err != nil {
		return nil, err
	}

	items := make([]Item, 0, len(list))
	for _, element := range list {
		item, ok := itemFromElement(element, mapping)
		if !ok {
			continue
		}
		if strings.TrimSpace(item.Title) == "" && strings.TrimSpace(item.Content) == "" {
			// 标题正文都空 = 这条映射没对上，跳过并记账（上层看到条目数变少就不会以为是成功）
			continue
		}
		item.Key, item.KeyLevel = degradeKey(item, mapping)
		items = append(items, item)
	}
	if len(items) == 0 {
		return nil, fmt.Errorf("按当前映射没能生成任何条目（列表 %d 条，字段路径可能对不上）", len(list))
	}
	return items, nil
}

func itemFromElement(element any, mapping model.MCPFieldMapping) (Item, bool) {
	item := Item{}
	switch v := element.(type) {
	case map[string]any:
		item.Title = stringAt(v, mapping.Title)
		item.URL = stringAt(v, mapping.URL)
		// 去重键的第一级：映射里指定的键字段（id / key / slug / url）
		if slot := strings.TrimSpace(mapping.ID); slot != "" {
			item.Key = stringAt(v, slot)
		}
		item.Content = stringAt(v, mapping.Content)
		item.PublishedAt = stringAt(v, mapping.PublishedAt)
		item.Author = stringAt(v, mapping.Author)
		item.Thumbnail = stringAt(v, mapping.Thumbnail)
		return item, true
	case string:
		// 数组元素是纯字符串：当成「标题=正文=这一行」
		item.Title = strings.TrimSpace(v)
		item.Content = strings.TrimSpace(v)
		return item, true
	case nil:
		return Item{}, false
	default:
		text := scalarToString(v)
		if text == "" {
			return Item{}, false
		}
		item.Title = text
		item.Content = text
		return item, true
	}
}

func stringAt(obj map[string]any, path string) string {
	if strings.TrimSpace(path) == "" {
		return ""
	}
	value, ok := Lookup(obj, path)
	if !ok {
		return ""
	}
	return valueToString(value)
}

// valueToString 取值转字符串：对象/数组转成格式化的 JSON（不丢内容），标量直接转。
func valueToString(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(v)
	case map[string]any, []any:
		raw, err := json.Marshal(v)
		if err != nil {
			return ""
		}
		return string(raw)
	case bool:
		return strconv.FormatBool(v)
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	default:
		return fmt.Sprint(v)
	}
}

func scalarToString(value any) string {
	switch v := value.(type) {
	case string:
		return strings.TrimSpace(v)
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(v)
	case nil:
		return ""
	default:
		return strings.TrimSpace(fmt.Sprint(v))
	}
}

// degradeKey 去重键的退化顺序（照抄 computeEntryHash）：
// 映射里指定的键字段 → 条目的链接字段 → 标题 + 时间。
func degradeKey(item Item, mapping model.MCPFieldMapping) (string, string) {
	if strings.TrimSpace(item.Key) != "" {
		return item.Key, model.MCPKeyLevelField
	}
	if strings.TrimSpace(item.URL) != "" {
		return item.URL, model.MCPKeyLevelLink
	}
	fallback := strings.TrimSpace(item.Title) + "|" + strings.TrimSpace(item.PublishedAt)
	return fallback, model.MCPKeyLevelFallback
}

// KeyOfElement 单独算一条原始元素在某映射下的去重键（预览里显示「这条用了哪一级」）。
func KeyOfElement(element any, mapping model.MCPFieldMapping) (string, string) {
	item, ok := itemFromElement(element, mapping)
	if !ok {
		return "", model.MCPKeyLevelFallback
	}
	return degradeKey(item, mapping)
}

// ---------------------------------------------------------------------------
// 纯文本档（④）：Markdown 切分
// ---------------------------------------------------------------------------

// TextSection 纯文本切出来的一节。
type TextSection struct {
	Title   string
	Content string
}

// splitText 按 Markdown 标题切；没有标题就按空行分块（每块首行当标题）。
// 只有「空文本」才判定切不出来 —— 单段文本也会成为一条（首行当标题），
// 让人在预览里直接看到结果，而不是甩一句「切不出来」。
func splitText(text string) ([]TextSection, bool) {
	if strings.TrimSpace(text) == "" {
		return nil, false
	}
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	var sections []TextSection
	var title string
	var buffer []string

	flush := func() {
		body := strings.TrimSpace(strings.Join(buffer, "\n"))
		if title == "" && body == "" {
			return
		}
		sections = append(sections, TextSection{Title: title, Content: body})
		buffer = nil
	}

	hasHeading := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if heading, ok := markdownHeading(trimmed); ok {
			flush()
			title = heading
			hasHeading = true
			continue
		}
		buffer = append(buffer, line)
	}
	flush()

	if !hasHeading {
		blocks := splitBlocks(text)
		if len(blocks) == 0 {
			return nil, false
		}
		return blocks, true
	}

	out := make([]TextSection, 0, len(sections))
	for _, section := range sections {
		if strings.TrimSpace(section.Title) == "" && strings.TrimSpace(section.Content) == "" {
			continue
		}
		out = append(out, section)
	}
	if len(out) == 0 {
		return nil, false
	}
	return out, true
}

func markdownHeading(line string) (string, bool) {
	for i := 1; i <= 6; i++ {
		prefix := strings.Repeat("#", i)
		if strings.HasPrefix(line, prefix+" ") {
			return strings.TrimSpace(strings.TrimPrefix(line, prefix)), true
		}
	}
	return "", false
}

func splitBlocks(text string) []TextSection {
	rawBlocks := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n\n")
	sections := make([]TextSection, 0, len(rawBlocks))
	for _, block := range rawBlocks {
		block = strings.TrimSpace(block)
		if block == "" {
			continue
		}
		lines := strings.Split(block, "\n")
		title := strings.TrimSpace(strings.TrimLeft(lines[0], "-*+#> "))
		content := strings.TrimSpace(strings.Join(lines[1:], "\n"))
		if content == "" {
			content = strings.TrimSpace(block)
		}
		sections = append(sections, TextSection{Title: title, Content: content})
	}
	return sections
}

func firstTextFromAny(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case []Content:
		return firstText(v)
	case map[string]any:
		if text, ok := v["text"].(string); ok {
			return text
		}
	}
	return ""
}

// ---------------------------------------------------------------------------
// 时间解析
// ---------------------------------------------------------------------------

var timeLayouts = []string{
	time.RFC3339Nano,
	time.RFC3339,
	"2006-01-02T15:04:05",
	"2006-01-02 15:04:05",
	"2006-01-02",
	"2006/01/02 15:04:05",
	"2006/01/02",
	"01/02/2006",
	time.RFC1123Z,
	time.RFC1123,
	time.ANSIC,
	time.UnixDate,
}

// ParseTime 把 MCP 返回的时间字段（字符串 / 数字时间戳 / {…} 对象）解析成时间。
func ParseTime(value any) (time.Time, bool) {
	switch v := value.(type) {
	case nil:
		return time.Time{}, false
	case float64:
		return fromUnixNumber(v)
	case json.Number:
		f, err := v.Float64()
		if err != nil {
			return time.Time{}, false
		}
		return fromUnixNumber(f)
	case string:
		text := strings.TrimSpace(v)
		if text == "" {
			return time.Time{}, false
		}
		if number, err := strconv.ParseFloat(text, 64); err == nil {
			return fromUnixNumber(number)
		}
		for _, layout := range timeLayouts {
			if t, err := time.Parse(layout, text); err == nil {
				return t.UTC(), true
			}
		}
		return time.Time{}, false
	case map[string]any:
		// {"$date": "..."} / {"seconds": 123} 这类
		for _, key := range []string{"$date", "date", "iso", "value", "text"} {
			if raw, ok := lookupCaseInsensitive(v, key); ok {
				if t, ok := ParseTime(raw); ok {
					return t, true
				}
			}
		}
		if raw, ok := lookupCaseInsensitive(v, "seconds"); ok {
			return ParseTime(raw)
		}
		return time.Time{}, false
	default:
		return time.Time{}, false
	}
}

func fromUnixNumber(value float64) (time.Time, bool) {
	if value <= 0 {
		return time.Time{}, false
	}
	// 毫秒
	if value > 1e11 {
		return time.UnixMilli(int64(value)).UTC(), true
	}
	return time.Unix(int64(value), 0).UTC(), true
}

func joinPath(prefix, segment string) string {
	if prefix == "" {
		return segment
	}
	return prefix + "." + segment
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
