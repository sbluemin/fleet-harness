#!/usr/bin/env node
import { verifyPromotedIpa } from "./lib/ios-promote.mjs";
verifyPromotedIpa("release", process.argv[2]);
