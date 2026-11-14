import { describe, expect, test } from "bun:test";
import { canTransition } from "./status";

describe("canTransition", () => {
  test("allows the main path pending → ready → decided", () => {
    expect(canTransition("pending", "ready")).toBe(true);
    expect(canTransition("ready", "decided")).toBe(true);
  });

  test("decided can only go to revisit or cancelled", () => {
    expect(canTransition("decided", "revisit")).toBe(true);
    expect(canTransition("decided", "ready")).toBe(false);
  });

  test("cancelled is terminal", () => {
    expect(canTransition("cancelled", "pending")).toBe(false);
  });
});
