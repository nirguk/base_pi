import { describe, expect, it } from "vitest";
import orLive from "../index";

describe("or-live composition", () => {
  it("registers both the metrics and live-provider surfaces from one extension", () => {
    const handlers = new Map<string, unknown[]>();
    const commands = new Map<string, unknown>();
    const tools = new Map<string, unknown>();
    const pi = {
      on(name: string, handler: unknown) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      registerCommand(name: string, command: unknown) {
        commands.set(name, command);
      },
      registerTool(tool: { name: string }) {
        tools.set(tool.name, tool);
      },
    };

    orLive(pi as any);

    expect(commands.has("or-metrics")).toBe(true);
    expect(commands.has("or-provider")).toBe(true);
    expect(tools.has("or_metrics_query")).toBe(true);
    expect(handlers.has("session_start")).toBe(true);
    expect(handlers.has("before_provider_headers")).toBe(true);
    expect(handlers.has("after_provider_response")).toBe(true);
    expect(handlers.has("message_start")).toBe(true);
    expect(handlers.has("message_end")).toBe(true);
    expect(handlers.has("turn_end")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);
  });
});
