import { runSessionBroker, type SessionBrokerOptions } from "../../../features/execution/host/session-host/broker.js";
import { createWindowsJobContainment, loadWindowsJobBindings } from "./windows-job-containment.js";

const raw = process.env.FLEET_SESSION_BROKER_BOOT;
delete process.env.FLEET_SESSION_BROKER_BOOT;
if (!raw) throw new Error("session_host_boot_required");
const boot = JSON.parse(raw) as SessionBrokerOptions;
const containment = process.platform === "win32" ? createWindowsJobContainment(loadWindowsJobBindings(), () => { throw new Error("session_host_containment_failed"); }) : undefined;
await runSessionBroker({ ...boot, containment });
