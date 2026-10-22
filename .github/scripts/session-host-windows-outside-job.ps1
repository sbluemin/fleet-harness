# Temporary branch-only verification machinery, not a product launcher.
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:RUNNER_TEMP ('fleet-session-outside-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
try {
  $cwd = Join-Path $env:GITHUB_WORKSPACE 'runtime/fleet-console'
  $node = (Get-Command node).Source
  $config = @{ cwd = $cwd; node = $node; result = (Join-Path $root 'result.json'); log = (Join-Path $root 'tests.log') }
  $config | ConvertTo-Json -Compress | Set-Content -Encoding utf8 (Join-Path $root 'config.json')
  $entry = Join-Path $root 'driver.cjs'
  @'
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8').replace(/^﻿/, ''));
let child;
const finish = (value) => fs.writeFileSync(cfg.result, JSON.stringify(value));
try {
  const requireConsole = createRequire(path.join(cfg.cwd, 'package.json'));
  const koffi = requireConsole('koffi'); const kernel = koffi.load('kernel32.dll');
  const current = kernel.func('__stdcall', 'GetCurrentProcess', 'void *', []);
  const inJob = kernel.func('__stdcall', 'IsProcessInJob', 'int', ['void *', 'void *', koffi.pointer('uint8')]);
  const query = kernel.func('__stdcall', 'QueryInformationJobObject', 'int', ['void *', 'int', koffi.pointer('uint8'), 'uint32', 'void *']);
  const state = Buffer.alloc(4);
  if (!inJob(current(), null, state)) throw new Error('driver_job_query_failed');
  const limits = Buffer.alloc(144); const hasLimits = query(null, 9, limits, limits.length, null);
  fs.writeFileSync(cfg.log, JSON.stringify({ stage: 'wmi-driver', inJob: state.readUInt32LE(0) !== 0, flags: hasLimits ? limits.readUInt32LE(16) : null }) + '\n');
  if (state.readUInt32LE(0) !== 0) throw new Error('wmi_driver_still_job_bound');
  const vitest = path.join(path.dirname(requireConsole.resolve('vitest/package.json')), 'vitest.mjs');
  const log = fs.openSync(cfg.log, 'a');
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'PATHEXT', 'NUMBER_OF_PROCESSORS']) if (process.env[key]) env[key] = process.env[key];
  env.PATH = path.dirname(cfg.node) + path.delimiter + (process.env.PATH || process.env.Path || ''); delete env.Path;
  env.HOME = __dirname; env.USERPROFILE = __dirname; env.TEMP = __dirname; env.TMP = __dirname; env.CI = 'true'; env.FORCE_COLOR = '0';
  child = spawn(cfg.node, [vitest, 'run', 'tests/console-lifecycle.integration.test.ts', '--reporter=verbose', '-t', 'Console session-host lifecycle integration'], { cwd: cfg.cwd, env, detached: true, windowsHide: true, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 360000);
  child.once('error', (error) => { clearTimeout(timeout); finish({ code: 1, error: error.code || error.name }); });
  child.once('exit', (code, signal) => { clearTimeout(timeout); finish({ code, signal }); });
} catch (error) { finish({ code: 1, error: error.message }); }
'@ | Set-Content -Encoding utf8 $entry
  # Win32_Process.Create is a CI experiment: it does not inherit the caller's restrictive runner job.
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ('"' + $node + '" "' + $entry + '"'); CurrentDirectory = $cwd }
  Write-Host ('WMI Create return=' + $created.ReturnValue + ' pid=' + $created.ProcessId)
  if ($created.ReturnValue -ne 0) { throw 'outside-job WMI launch failed' }
  $deadline = (Get-Date).AddSeconds(420)
  while (!(Test-Path $config.result) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
  if (!(Test-Path $config.result)) { throw 'outside-job result deadline exceeded' }
  $log = if (Test-Path $config.log) { Get-Content -Raw $config.log } else { '' }
  Write-Host $log
  $log | Set-Content -Encoding utf8 (Join-Path $env:GITHUB_WORKSPACE 'session-host-outside-job.log')
  $result = Get-Content -Raw $config.result | ConvertFrom-Json
  Write-Host ('outside-job exit=' + ($result | ConvertTo-Json -Compress))
  if ($result.code -ne 0) { throw 'outside-job representative tests failed' }
  $plain = [regex]::Replace($log, '\x1B\[[0-?]*[ -/]*[@-~]', '')
  $summary = [regex]::Match($plain, 'Tests\s+(\d+) passed')
  if (!$summary.Success -or [int]$summary.Groups[1].Value -lt 2) { throw 'outside-job representative tests did not report at least two passed' }
} finally {
  # A live timed-out driver owns a bounded six-minute child deadline; never remove its inputs mid-run.
  if ((Test-Path (Join-Path $root 'result.json')) -or !(Test-Path (Join-Path $root 'driver.cjs'))) {
    Remove-Item -Recurse -Force $root
  }
}
