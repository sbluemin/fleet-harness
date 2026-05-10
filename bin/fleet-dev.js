#!/usr/bin/env node
process.env.FLEET_HARNESS_DEV = "1";

import("./fleet-main.mjs");
