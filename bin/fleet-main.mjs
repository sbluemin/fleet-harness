#!/usr/bin/env node

import { main } from "@sbluemin/fleet-coding-agent";
import fleetExtension from "@sbluemin/fleet-harness";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

process.title = "fleet";
process.emitWarning = () => {};

// 로컬 LLM 응답 지연이 길어도 undici 타임아웃으로 스트림이 끊기지 않게 한다.
setGlobalDispatcher(new EnvHttpProxyAgent({ bodyTimeout: 0, headersTimeout: 0 }));

const PACKAGE_SUBCOMMANDS = new Set(["install", "remove", "uninstall", "update", "list", "config"]);
const userArgv = process.argv.slice(2);
// 패키지 서브커맨드는 첫 토큰 매칭이 필요하므로 그 경우에만 --no-extensions 자동 삽입을 건너뛴다.
const argv = PACKAGE_SUBCOMMANDS.has(userArgv[0]) ? userArgv : ["--no-extensions", ...userArgv];

main(argv, { extensionFactories: [fleetExtension] });
