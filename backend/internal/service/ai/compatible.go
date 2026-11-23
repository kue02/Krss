package ai

import (
	"context"
	"strings"

	"github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"
)

// CompatibleProvider implements Provider for OpenAI-compatible APIs.
// This supports services like OpenRouter, Azure OpenAI, Ollama, etc.
type CompatibleProvider struct {
	client         openai.Client
	model          string
	requestOptions map[string]any
}

// NewCompatibleProvider creates a new OpenAI-compatible provider.
func NewCompatibleProvider(apiKey, baseURL, model string, requestOptions map[string]any) (*CompatibleProvider, error) {
	client := openai.NewClient(
		option.WithAPIKey(apiKey),
		option.WithBaseURL(baseURL),
	)
	return &CompatibleProvider{
		client:         client,
		model:          model,
		requestOptions: requestOptions,
	}, nil
}

// Test sends a test message and returns the response.
func (p *CompatibleProvider) Test(ctx context.Context) (string, error) {
	params := openai.ChatCompletionNewParams{
		Model: openai.ChatModel(p.model),
		Messages: []openai.ChatCompletionMessageParamUnion{
			openai.UserMessage("Hello world"),
		},
		MaxCompletionTokens: openai.Int(50),
	}

	applyRequestOptions(&params, p.requestOptions)

	return p.completeChat(ctx, params)
}

// completeChat performs a chat completion, falling back to a streaming request
// when the gateway answers a non-streaming request with an SSE response.
//
// Some OpenAI-compatible gateways ignore stream:false and reply with
// Content-Type: text/event-stream. The SDK then fails to decode that body as
// JSON, so we retry the same params as a stream and accumulate its chunks.
func (p *CompatibleProvider) completeChat(ctx context.Context, params openai.ChatCompletionNewParams) (string, error) {
	resp, err := p.client.Chat.Completions.New(ctx, params)
	if err == nil {
		if len(resp.Choices) == 0 {
			return "", nil
		}
		return resp.Choices[0].Message.Content, nil
	}

	if !isEventStreamError(err) {
		return "", err
	}

	stream := p.client.Chat.Completions.NewStreaming(ctx, params)
	defer stream.Close()

	var acc openai.ChatCompletionAccumulator
	for stream.Next() {
		acc.AddChunk(stream.Current())
	}
	if err := stream.Err(); err != nil {
		return "", err
	}

	if len(acc.Choices) == 0 {
		return "", nil
	}
	return acc.Choices[0].Message.Content, nil
}

// isEventStreamError reports whether err is the SDK's complaint that the server
// returned a text/event-stream response where a JSON body was expected.
func isEventStreamError(err error) bool {
	return err != nil && strings.Contains(err.Error(), "text/event-stream")
}

// Name returns the provider name.
func (p *CompatibleProvider) Name() string {
	return ProviderCompatible
}

// SummarizeStream generates a summary using streaming.
func (p *CompatibleProvider) SummarizeStream(ctx context.Context, systemPrompt, content string) (<-chan string, <-chan error) {
	textCh := make(chan string)
	errCh := make(chan error, 1)

	go func() {
		defer close(textCh)
		defer close(errCh)

		messages := []openai.ChatCompletionMessageParamUnion{}
		if systemPrompt != "" {
			messages = append(messages, openai.SystemMessage(systemPrompt))
		}
		messages = append(messages, openai.UserMessage(content))

		params := openai.ChatCompletionNewParams{
			Model:    openai.ChatModel(p.model),
			Messages: messages,
		}

		applyRequestOptions(&params, p.requestOptions)

		stream := p.client.Chat.Completions.NewStreaming(ctx, params)
		defer stream.Close()

		for stream.Next() {
			chunk := stream.Current()
			for _, choice := range chunk.Choices {
				if choice.Delta.Content != "" {
					select {
					case textCh <- choice.Delta.Content:
					case <-ctx.Done():
						return
					}
				}
			}
		}

		if err := stream.Err(); err != nil {
			select {
			case errCh <- err:
			default:
			}
		}
	}()

	return textCh, errCh
}

// Complete generates a response without streaming.
func (p *CompatibleProvider) Complete(ctx context.Context, systemPrompt, content string) (string, error) {
	messages := []openai.ChatCompletionMessageParamUnion{}
	if systemPrompt != "" {
		messages = append(messages, openai.SystemMessage(systemPrompt))
	}
	messages = append(messages, openai.UserMessage(content))

	params := openai.ChatCompletionNewParams{
		Model:    openai.ChatModel(p.model),
		Messages: messages,
	}

	applyRequestOptions(&params, p.requestOptions)

	return p.completeChat(ctx, params)
}
