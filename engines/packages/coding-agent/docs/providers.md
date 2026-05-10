# Providers

Pi ships with **no built-in LLM providers**. Register providers via extensions or `~/.pi/agent/models.json`. See [custom-provider.md](custom-provider.md) and [models.md](models.md).

## Table of Contents

- [Auth File](#auth-file)
- [Key Resolution](#key-resolution)
- [Custom Providers](#custom-providers)
- [Resolution Order](#resolution-order)

## Auth File

Store credentials in `~/.pi/agent/auth.json`:

```json
{
  "my-provider": { "type": "api_key", "key": "sk-..." }
}
```

The file is created with `0600` permissions (user read/write only). Use `/login` in interactive mode to store credentials, or edit the file directly.

### Key Resolution

The `key` field supports three formats:

- **Shell command:** `"!command"` executes and uses stdout (cached for process lifetime)
  ```json
  { "type": "api_key", "key": "!security find-generic-password -ws 'my-service'" }
  { "type": "api_key", "key": "!op read 'op://vault/item/credential'" }
  ```
- **Environment variable:** Uses the value of the named variable
  ```json
  { "type": "api_key", "key": "MY_API_KEY" }
  ```
- **Literal value:** Used directly
  ```json
  { "type": "api_key", "key": "sk-..." }
  ```

OAuth credentials are also stored here after `/login` and managed automatically.

## Custom Providers

**Via models.json:** Add Ollama, LM Studio, vLLM, or any provider that speaks a supported API (OpenAI Completions, OpenAI Responses, Anthropic Messages, Google Generative AI). See [models.md](models.md).

**Via extensions:** For providers that need custom API implementations or OAuth flows, create an extension. See [custom-provider.md](custom-provider.md) and [examples/extensions/custom-provider-gitlab-duo](../examples/extensions/custom-provider-gitlab-duo/).

## Resolution Order

When resolving credentials for a provider:

1. CLI `--api-key` flag
2. `auth.json` entry (API key or OAuth token)
3. Environment variable
4. Custom provider keys from `models.json`
