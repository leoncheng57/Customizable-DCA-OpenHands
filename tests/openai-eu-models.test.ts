import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODELS,
  OPENAI_EU_BASE_URL_DEFAULT,
  isOpenAiModel,
  llmSettingsForModel,
  readConfigFromEnv,
} from "../server/openhands/setup.js";

const cfg = { openaiApiKey: "sk-openai", openaiEuBaseUrl: "https://eu.api.openai.com/v1" };

describe("isOpenAiModel", () => {
  it("matches only litellm `openai/` ids", () => {
    expect(isOpenAiModel("openai/gpt-5.6-sol")).toBe(true);
    expect(isOpenAiModel("anthropic/claude-sonnet-5")).toBe(false);
  });
});

describe("llmSettingsForModel", () => {
  it("leaves Anthropic ids to the agent's own credentials", () => {
    expect(llmSettingsForModel(cfg, "anthropic/claude-sonnet-5")).toEqual({
      model: "anthropic/claude-sonnet-5",
    });
  });

  it("attaches the EU base_url and api_key to openai ids", () => {
    expect(llmSettingsForModel(cfg, "openai/gpt-5.6-sol")).toEqual({
      model: "openai/gpt-5.6-sol",
      base_url: "https://eu.api.openai.com/v1",
      api_key: "sk-openai",
    });
  });

  it("falls back to the EU endpoint when no base url is configured", () => {
    expect(llmSettingsForModel({ ...cfg, openaiEuBaseUrl: "" }, "openai/gpt-5.6-luna").base_url).toBe(
      OPENAI_EU_BASE_URL_DEFAULT,
    );
  });

  it("omits api_key entirely when none is configured", () => {
    expect(llmSettingsForModel({ ...cfg, openaiApiKey: "" }, "openai/gpt-5.6-terra")).not.toHaveProperty("api_key");
  });

  it("covers every openai id shipped in the model dropdown", () => {
    const openAiIds = DEFAULT_MODELS.filter(isOpenAiModel);
    expect(openAiIds.length).toBeGreaterThan(0);
    for (const id of openAiIds) {
      expect(llmSettingsForModel(cfg, id)).toMatchObject({ base_url: expect.any(String), api_key: "sk-openai" });
    }
  });
});

describe("readConfigFromEnv", () => {
  it("picks up the OpenAI key and prefers the EU override over OPENAI_BASE_URL", () => {
    const config = readConfigFromEnv({
      OPENAI_API_KEY: "sk-from-env",
      OPENHANDS_OPENAI_EU_BASE_URL: "https://eu.example.com/v1/",
      OPENAI_BASE_URL: "https://global.example.com/v1",
    } as NodeJS.ProcessEnv);
    expect(config.openaiApiKey).toBe("sk-from-env");
    expect(config.openaiEuBaseUrl).toBe("https://eu.example.com/v1");
  });

  it("falls back to OPENAI_BASE_URL and defaults an absent key to empty", () => {
    const config = readConfigFromEnv({ OPENAI_BASE_URL: "https://global.example.com/v1" } as NodeJS.ProcessEnv);
    expect(config.openaiEuBaseUrl).toBe("https://global.example.com/v1");
    expect(config.openaiApiKey).toBe("");
  });
});
