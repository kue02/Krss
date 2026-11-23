package opml

import (
	"bytes"
	"encoding/xml"
	"io"
)

type Document struct {
	XMLName xml.Name `xml:"opml"`
	Version string   `xml:"version,attr"`
	Head    Head     `xml:"head"`
	Body    Body     `xml:"body"`
}

type Head struct {
	Title        string `xml:"title,omitempty"`
	DateCreated  string `xml:"dateCreated,omitempty"`
	DateModified string `xml:"dateModified,omitempty"`
}

type Body struct {
	Outlines []Outline `xml:"outline"`
}

// Outline 是 OPML 的 <outline> 元素。
//
// 标准字段 Text/Title/Type/XMLURL/HTMLURL 之外，Krss 追加了三个自定义属性，
// 用来在导出/导入时无损还原订阅的内容类型与来源（标准 OPML 阅读器会忽略未知属性，不影响兼容性）：
//   - krssType        内容类型（article/picture/notification/social）—— 对应前端频道视图
//   - krssSourceType  订阅来源（rss/mcp）
//   - krssMCPConfig   MCP 订阅的连接配置（JSON 字符串）
//
// 标准 type="rss" 语义保持不变：即使是对 MCP 订阅，Type 仍是 "rss"（它是一个可订阅源），
// 真假由 krssSourceType 区分。
//
// 采用无命名空间的驼峰属性名（krssType 而非 krss:type）：自定义属性合法，且避开 Go
// encoding/xml 对未绑定前缀命名空间的解析歧义，保证编解码可往返。
type Outline struct {
	Text           string    `xml:"text,attr,omitempty"`
	Title          string    `xml:"title,attr,omitempty"`
	Type           string    `xml:"type,attr,omitempty"`
	XMLURL         string    `xml:"xmlUrl,attr,omitempty"`
	HTMLURL        string    `xml:"htmlUrl,attr,omitempty"`
	KrssType       string    `xml:"krssType,attr,omitempty"`
	KrssSourceType string    `xml:"krssSourceType,attr,omitempty"`
	KrssMCPConfig  string    `xml:"krssMCPConfig,attr,omitempty"`
	Outlines       []Outline `xml:"outline,omitempty"`
}

func Parse(r io.Reader) (Document, error) {
	decoder := xml.NewDecoder(r)
	var doc Document
	if err := decoder.Decode(&doc); err != nil {
		return Document{}, err
	}
	return doc, nil
}

func Encode(doc Document) ([]byte, error) {
	buf := &bytes.Buffer{}
	buf.WriteString(xml.Header)
	encoder := xml.NewEncoder(buf)
	encoder.Indent("", "  ")
	if err := encoder.Encode(doc); err != nil {
		return nil, err
	}
	if err := encoder.Flush(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
