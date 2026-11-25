// Read error screenshots with a vision model (0.9.42) — Ollama's /api/chat
// accepts an image (base64) alongside the question, but only when the model
// is a vision model (llava, moondream, llama3.2-vision, ...). A code model
// like qwen2.5-coder cannot see images at all, so this module picks a vision
// model from the ones the user already pulled, and says plainly which small
// model to pull when none is installed.
//
// The image itself never leaves the user's machine: it goes only to their
// own Ollama host, like the workspace context already does. Nothing is
// stored — the base64 is held in memory for one question, then dropped.

import { fetchWithRetry } from "./llm";

/** Model names Ollama can see images with (matched as a substring, case-insensitive). */
export const VISION_MODEL_HINTS = ["llava", "llama3.2-vision", "moondream", "bakllava", "minicpm-v", "granite3.2-vision", "qwen2-vl", "llama4"];

/** True when the model name looks like a vision model. */
export function isVisionModel(model: string): boolean {
  const lower = model.toLowerCase();
  return VISION_MODEL_HINTS.some((h) => lower.includes(h));
}

/**
 * Pick the vision model to use: the current model when it can see images,
 * otherwise the first installed vision model, otherwise null (nothing
 * installed that can see — the caller offers to pull one).
 */
export function pickVisionModel(models: string[], currentModel: string): string | null {
  if (currentModel && isVisionModel(currentModel)) {
    return currentModel;
  }
  return models.find((m) => isVisionModel(m)) || null;
}

/** The small vision model suggested when none is installed — 1.8B, fast on CPU. */
export const DEFAULT_VISION_MODEL = "moondream";

/** Plain-words request to read a screenshot, e.g. "read this screenshot" / "what does this error say". */
export function isVisionRequest(text: string): boolean {
  return /^\s*(read|explain|describe|what('s| is| does)|check)\s+(this|the|my)?\s*(error\s+)?(screenshot|image|picture|screen|photo)\b/i.test(text.trim())
    || /screenshot|what('| i)s (on|in) (this|the) (screen|image|picture)/i.test(text);
}

/** Image extensions the attach flow accepts. */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];

/** Largest image accepted (10 MB) — bigger screenshots are slow on CPU and usually a full desktop grab. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function mimeFromExtension(ext: string): string {
  const lower = ext.toLowerCase();
  if (lower === "jpg" || lower === "jpeg") {
    return "image/jpeg";
  }
  if (lower === "webp") {
    return "image/webp";
  }
  if (lower === "gif") {
    return "image/gif";
  }
  return "image/png";
}

export interface VisionResult {
  /** The model's answer, or empty when it failed. */
  answer: string;
  /** Plain-words error when the image could not be described. Empty when it worked. */
  error: string;
}

/**
 * Ask a vision model to describe / answer about one image. Non-streaming:
 * the whole answer comes back at once, so the caller can show it as one
 * reply. `baseUrl` is overridable for tests (a fake Ollama server).
 */
export async function describeImage(
  ollamaHost: string,
  model: string,
  base64: string,
  question: string,
  baseUrl?: string
): Promise<VisionResult> {
  const host = (baseUrl || ollamaHost).replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  try {
    const res = await fetchWithRetry(host + "/api/chat", {
      body: JSON.stringify({
        messages: [{ content: question, images: [base64], role: "user" }],
        model,
        stream: false
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: controller.signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 404) {
        return { answer: "", error: "Ollama says model `" + model + "` was not found — pull it first (ollama pull " + model + "), then try again." };
      }
      return { answer: "", error: "Ollama could not read the image (" + res.status + "). " + text.slice(0, 200) };
    }
    const data: any = await res.json().catch(() => null);
    const content = typeof data?.message?.content === "string" ? data.message.content.trim() : "";
    if (!content) {
      return { answer: "", error: "The vision model returned an empty reply — try a different pulled vision model, or a smaller image." };
    }
    return { answer: content, error: "" };
  } catch (err: any) {
    if (String(err?.name || "") === "AbortError") {
      return { answer: "", error: "Reading the image timed out (3 minutes) — vision models are slow on CPU. Try a smaller image, or the moondream model." };
    }
    return { answer: "", error: "Could not reach Ollama at " + host + " — start it first (ollama serve), then try again." };
  } finally {
    clearTimeout(timer);
  }
}
