import { describe, expect, it } from "vitest";
import { effectiveNtfyConfig } from "../server/openhands/notifier.js";

const ENV = {
  url: "https://ntfy.sh",
  topic: "",
  token: "",
  notifyIdle: true,
  hubPublicUrl: "http://localhost:5173",
};

const settingsWith = (prefs: Record<string, unknown>) => ({
  misc_settings: { customizable_dca: { openhands_notifications: prefs } },
});

describe("effectiveNtfyConfig", () => {
  it("is disabled without a topic anywhere", () => {
    expect(effectiveNtfyConfig(ENV, null).enabled).toBe(false);
    expect(effectiveNtfyConfig(ENV, settingsWith({})).enabled).toBe(false);
  });

  it("env topic enables; settings topic overrides env", () => {
    const envTopic = effectiveNtfyConfig({ ...ENV, topic: "from-env" }, null);
    expect(envTopic).toMatchObject({ enabled: true, topic: "from-env", url: "https://ntfy.sh" });

    const overridden = effectiveNtfyConfig(
      { ...ENV, topic: "from-env" },
      settingsWith({ ntfy_topic: "from-ui", ntfy_url: "https://my.ntfy.example/" }),
    );
    expect(overridden).toMatchObject({ enabled: true, topic: "from-ui", url: "https://my.ntfy.example" });
  });

  it("settings kill switch wins over an env topic", () => {
    const cfg = effectiveNtfyConfig({ ...ENV, topic: "from-env" }, settingsWith({ enabled: false }));
    expect(cfg.enabled).toBe(false);
  });

  it("notifyIdle: settings override env in both directions", () => {
    expect(effectiveNtfyConfig({ ...ENV, topic: "t" }, settingsWith({ notify_idle: false })).notifyIdle).toBe(false);
    expect(effectiveNtfyConfig({ ...ENV, topic: "t", notifyIdle: false }, settingsWith({ notify_idle: true })).notifyIdle).toBe(true);
    expect(effectiveNtfyConfig({ ...ENV, topic: "t", notifyIdle: false }, settingsWith({})).notifyIdle).toBe(false);
  });
});
