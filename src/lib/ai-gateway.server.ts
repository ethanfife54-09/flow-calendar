// Server-only helper to call the Lovable AI Gateway.
const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

export type TextPart = { type: "text"; text: string };
export type ImagePart = { type: "image_url"; image_url: { url: string } };
export type ContentPart = TextPart | ImagePart;
export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
};

export async function chatCompletion(opts: {
  model?: string;
  messages: ChatMessage[];
  response_format?: { type: "json_object" };
  temperature?: number;
}): Promise<string> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("Missing LOVABLE_API_KEY on the server.");

  const res = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: opts.model ?? "google/gemini-2.5-flash",
      messages: opts.messages,
      response_format: opts.response_format,
      temperature: opts.temperature ?? 0.2,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 429) throw new Error("AI rate limit reached. Please try again shortly.");
    if (res.status === 402) throw new Error("AI credits exhausted. Please add credits in your workspace.");
    throw new Error(`AI request failed [${res.status}]: ${body}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? "";
}
