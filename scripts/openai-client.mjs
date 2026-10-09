// Shared cheap-classification call used by both classifiers.
import { costUSD } from "./pricing.mjs";

const { OPENAI_API_KEY, CLASSIFY_MODEL } = process.env;

export async function chatJSON(systemPrompt, userContent, fallback) {
  return (await chatJSONWithUsage(systemPrompt, userContent, fallback)).data;
}

// Same call, plus the token usage OpenAI reports -- feeds the event log.
// responseFormat defaults to loose JSON mode (existing callers unchanged). Pass
// {type:"json_schema", json_schema:{name, strict:true, schema}} to make the API
// enforce the shape -- loose mode lets the model rename keys (seen in QA review).
export async function chatJSONWithUsage(systemPrompt, userContent, fallback, responseFormat = { type: "json_object" }) {
  if (!OPENAI_API_KEY || !CLASSIFY_MODEL) {
    throw new Error("Missing required env var: OPENAI_API_KEY or CLASSIFY_MODEL");
  }
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLASSIFY_MODEL,
      response_format: responseFormat,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI call failed: ${res.status} ${await res.text()}`);
  }
  const { choices, usage: rawUsage } = await res.json();
  const inputTokens = rawUsage?.prompt_tokens ?? null;
  const outputTokens = rawUsage?.completion_tokens ?? null;
  const usage = {
    model: CLASSIFY_MODEL,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: costUSD(CLASSIFY_MODEL, inputTokens, outputTokens),
  };
  const text = choices?.[0]?.message?.content ?? "{}";
  try {
    return { data: JSON.parse(text), usage };
  } catch {
    console.error(`Unparseable model response, using fallback: ${text}`);
    return { data: fallback, usage };
  }
}
