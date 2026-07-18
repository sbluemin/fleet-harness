import { expect, it } from "vitest";
import { AnalystSession } from "../src/session.js";
it("exports an explicit disposable session lifecycle", () => { expect(typeof AnalystSession.prototype.start).toBe("function"); expect(typeof AnalystSession.prototype.send).toBe("function"); expect(typeof AnalystSession.prototype.dispose).toBe("function"); });
