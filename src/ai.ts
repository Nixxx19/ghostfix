import Anthropic from "@anthropic-ai/sdk";

export interface AIProvider {
  name: string;
  analyzeAndFix(prompt: string): Promise<string>;
}

// --- Claude (Anthropic) ---
class ClaudeProvider implements AIProvider {
  name = "claude";
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async analyzeAndFix(prompt: string): Promise<string> {
    const response = await this.client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8096,
      messages: [{ role: "user", content: prompt }],
    });

    const block = response.content.find((b) => b.type === "text");
    return block ? block.text : "";
  }
}

// --- Gemini (Google) ---
class GeminiProvider implements AIProvider {
  name = "gemini";
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async analyzeAndFix(prompt: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    });

    const data: any = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  }
}

// --- OpenRouter (supports many models) ---
class OpenRouterProvider implements AIProvider {
  name = "openrouter";
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model || "google/gemini-2.0-flash-001";
  }

  async analyzeAndFix(prompt: string): Promise<string> {
    const res = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/github-issue-fixer",
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: prompt }],
        }),
      }
    );

    const data: any = await res.json();
    return data.choices?.[0]?.message?.content ?? "";
  }
}

// --- OpenAI-compatible (OpenAI, Groq, Together, etc.) ---
class OpenAICompatibleProvider implements AIProvider {
  name: string;
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(name: string, apiKey: string, baseUrl: string, model: string) {
    this.name = name;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.model = model;
  }

  async analyzeAndFix(prompt: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data: any = await res.json();
    return data.choices?.[0]?.message?.content ?? "";
  }
}

// --- Provider factory ---
export function createProvider(): AIProvider {
  // Priority: check which API key is available
  if (process.env.ANTHROPIC_API_KEY) {
    return new ClaudeProvider(process.env.ANTHROPIC_API_KEY);
  }
  if (process.env.GEMINI_API_KEY) {
    return new GeminiProvider(process.env.GEMINI_API_KEY);
  }
  if (process.env.OPENROUTER_API_KEY) {
    return new OpenRouterProvider(
      process.env.OPENROUTER_API_KEY,
      process.env.OPENROUTER_MODEL
    );
  }
  if (process.env.OPENAI_API_KEY) {
    return new OpenAICompatibleProvider(
      "openai",
      process.env.OPENAI_API_KEY,
      "https://api.openai.com/v1",
      process.env.OPENAI_MODEL || "gpt-4o"
    );
  }
  if (process.env.GROQ_API_KEY) {
    return new OpenAICompatibleProvider(
      "groq",
      process.env.GROQ_API_KEY,
      "https://api.groq.com/openai/v1",
      process.env.GROQ_MODEL || "llama-3.3-70b-versatile"
    );
  }
  if (process.env.TOGETHER_API_KEY) {
    return new OpenAICompatibleProvider(
      "together",
      process.env.TOGETHER_API_KEY,
      "https://api.together.xyz/v1",
      process.env.TOGETHER_MODEL || "meta-llama/Llama-3.3-70B-Instruct-Turbo"
    );
  }

  throw new Error(
    "No AI provider configured. Set one of: ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY, GROQ_API_KEY, TOGETHER_API_KEY"
  );
}
