package opml

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestOPML_ParseAndEncode(t *testing.T) {
	opmlData := `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Test OPML</title>
  </head>
  <body>
    <outline text="Folder">
      <outline text="Feed" type="rss" xmlUrl="http://example.com/rss"/>
    </outline>
  </body>
</opml>`

	doc, err := Parse(strings.NewReader(opmlData))
	require.NoError(t, err)
	require.Equal(t, "2.0", doc.Version)
	require.Equal(t, "Test OPML", doc.Head.Title)
	require.Len(t, doc.Body.Outlines, 1)
	require.Equal(t, "Folder", doc.Body.Outlines[0].Text)
	require.Len(t, doc.Body.Outlines[0].Outlines, 1)
	require.Equal(t, "Feed", doc.Body.Outlines[0].Outlines[0].Text)

	encoded, err := Encode(doc)
	require.NoError(t, err)
	require.Contains(t, string(encoded), "Test OPML")
	require.Contains(t, string(encoded), "xmlUrl=\"http://example.com/rss\"")
}

func TestOPML_Parse_InvalidXML(t *testing.T) {
	_, err := Parse(strings.NewReader("<opml>"))
	require.Error(t, err)
}

func TestOPML_CustomKrssAttributesRoundTrip(t *testing.T) {
	doc := Document{
		Version: "2.0",
		Body: Body{Outlines: []Outline{
			{Text: "Pics", Title: "Pics", KrssType: "picture", Outlines: []Outline{
				{Text: "MCP", Title: "MCP", Type: "rss", XMLURL: "mcp://example/server", KrssType: "article", KrssSourceType: "mcp", KrssMCPConfig: `{"url":"mcp://example/server"}`},
			}},
			{Text: "Feed", Title: "Feed", Type: "rss", XMLURL: "https://a.com/rss", KrssType: "social", KrssSourceType: "rss"},
		}},
	}

	encoded, err := Encode(doc)
	require.NoError(t, err)
	out := string(encoded)
	require.Contains(t, out, `krssType="picture"`)
	require.Contains(t, out, `krssSourceType="mcp"`)
	require.Contains(t, out, `krssType="social"`)

	parsed, err := Parse(strings.NewReader(out))
	require.NoError(t, err)
	require.Equal(t, "picture", parsed.Body.Outlines[0].KrssType)
	child := parsed.Body.Outlines[0].Outlines[0]
	require.Equal(t, "mcp", child.KrssSourceType)
	require.Equal(t, `{"url":"mcp://example/server"}`, child.KrssMCPConfig)
	require.Equal(t, "social", parsed.Body.Outlines[1].KrssType)
	require.Equal(t, "rss", parsed.Body.Outlines[1].KrssSourceType)
}
