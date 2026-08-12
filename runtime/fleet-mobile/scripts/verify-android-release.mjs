#!/usr/bin/env node
import { verifyPromotedApk } from "./lib/android-promote.mjs";

verifyPromotedApk("release", process.argv[2]);
