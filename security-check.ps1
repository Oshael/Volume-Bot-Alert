param(
  [string]$BaseUrl = "http://localhost:3000",
  [string]$UserEmail = "",
  [string]$UserPassword = "",
  [string]$UserBEmail = "",
  [string]$UserBPassword = "",
  [string]$AdminEmail = "",
  [string]$AdminPassword = "",
  [switch]$RunRateLimit,
  [int]$RateLimitRequests = 130,
  [switch]$RunStress,
  [int]$StressRequests = 250,
  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
$results = @()

function Add-Result {
  param(
    [string]$Id,
    [string]$Name,
    [ValidateSet("PASS", "FAIL", "SKIP", "WARN")]
    [string]$Status,
    [string]$Details
  )
  $script:results += [pscustomobject]@{
    id      = $Id
    name    = $Name
    status  = $Status
    details = $Details
  }
}

function Invoke-Api {
  param(
    [ValidateSet("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")]
    [string]$Method,
    [string]$Path,
    [hashtable]$Headers = @{},
    $Body = $null,
    [string]$ContentType = "application/json"
  )

  $uri = "$BaseUrl$Path"
  $params = @{
    Uri         = $uri
    Method      = $Method
    Headers     = $Headers
    UseBasicParsing = $true
  }

  if ($Body -ne $null) {
    if ($Body -is [string]) {
      $params.Body = $Body
    } else {
      $params.Body = ($Body | ConvertTo-Json -Depth 10 -Compress)
    }
    $params.ContentType = $ContentType
  }

  try {
    $res = Invoke-WebRequest @params
    $json = $null
    try { $json = $res.Content | ConvertFrom-Json } catch {}
    return [pscustomobject]@{
      ok         = $true
      statusCode = [int]$res.StatusCode
      content    = $res.Content
      json       = $json
      headers    = $res.Headers
      error      = ""
    }
  } catch {
    $status = 0
    $content = ""
    $headers = @{}
    if ($_.Exception.Response) {
      try { $status = [int]$_.Exception.Response.StatusCode } catch {}
      try { $headers = $_.Exception.Response.Headers } catch {}
      try { $content = $_.ErrorDetails.Message } catch {}
    } else {
      $content = $_.Exception.Message
    }
    $json = $null
    try { $json = $content | ConvertFrom-Json } catch {}
    return [pscustomobject]@{
      ok         = $false
      statusCode = $status
      content    = $content
      json       = $json
      headers    = $headers
      error      = $_.Exception.Message
    }
  }
}

function Get-Token {
  param([string]$Email, [string]$Password)
  if ([string]::IsNullOrWhiteSpace($Email) -or [string]::IsNullOrWhiteSpace($Password)) {
    return $null
  }
  $res = Invoke-Api -Method POST -Path "/api/auth/login" -Body @{
    email    = $Email
    password = $Password
  }
  if ($res.statusCode -eq 200 -and $res.json -and $res.json.token) {
    return $res.json.token
  }
  return $null
}

Write-Host ""
Write-Host "== Security Check =="
Write-Host "Base URL: $BaseUrl"
Write-Host ""

# 0) Health
$health = Invoke-Api -Method GET -Path "/api/health"
if ($health.statusCode -eq 200) {
  Add-Result -Id "T0" -Name "Health check" -Status "PASS" -Details "Server reachable."
} elseif ($health.statusCode -eq 429) {
  Add-Result -Id "T0" -Name "Health check" -Status "WARN" -Details "Server reachable but currently rate-limited (429)."
} else {
  Add-Result -Id "T0" -Name "Health check" -Status "FAIL" -Details "Cannot reach server (status $($health.statusCode))."
}

# 2) User enumeration resistance
if ([string]::IsNullOrWhiteSpace($UserEmail)) {
  Add-Result -Id "T2" -Name "User enumeration" -Status "SKIP" -Details "Provide -UserEmail to run this test."
} else {
  $realFail = Invoke-Api -Method POST -Path "/api/auth/login" -Body @{ email = $UserEmail; password = "wrong-password-123" }
  $fakeFail = Invoke-Api -Method POST -Path "/api/auth/login" -Body @{ email = "nonexistent_$([guid]::NewGuid().ToString('N').Substring(0,8))@example.com"; password = "wrong-password-123" }

  if (($realFail.statusCode -eq $fakeFail.statusCode) -and ($realFail.content -eq $fakeFail.content)) {
    Add-Result -Id "T2" -Name "User enumeration" -Status "PASS" -Details "Response for existing/non-existing user is indistinguishable."
  } elseif (($realFail.statusCode -in 401,429) -and ($fakeFail.statusCode -in 401,429)) {
    Add-Result -Id "T2" -Name "User enumeration" -Status "WARN" -Details "Both denied but payload differs. Check message consistency."
  } else {
    Add-Result -Id "T2" -Name "User enumeration" -Status "FAIL" -Details "Different behavior observed for existing vs non-existing user."
  }
}

# 3) JWT and session revocation
$userToken = Get-Token -Email $UserEmail -Password $UserPassword
if (-not $userToken) {
  Add-Result -Id "T3" -Name "JWT/session" -Status "SKIP" -Details "Provide valid -UserEmail/-UserPassword to run."
} else {
  $invalid = Invoke-Api -Method GET -Path "/api/auth/me" -Headers @{ Authorization = "Bearer invalid.token.value" }
  $meOk = Invoke-Api -Method GET -Path "/api/auth/me" -Headers @{ Authorization = "Bearer $userToken" }
  $logout = Invoke-Api -Method POST -Path "/api/auth/logout" -Headers @{ Authorization = "Bearer $userToken" }
  $meAfter = Invoke-Api -Method GET -Path "/api/auth/me" -Headers @{ Authorization = "Bearer $userToken" }

  if ($invalid.statusCode -eq 401 -and $meOk.statusCode -eq 200 -and $logout.statusCode -in 200,204 -and $meAfter.statusCode -eq 401) {
    Add-Result -Id "T3" -Name "JWT/session" -Status "PASS" -Details "Invalid token denied and revoked session cannot be reused."
  } else {
    Add-Result -Id "T3" -Name "JWT/session" -Status "FAIL" -Details "Unexpected token/session behavior. invalid=$($invalid.statusCode), me=$($meOk.statusCode), logout=$($logout.statusCode), meAfter=$($meAfter.statusCode)"
  }

  # Re-login for later tests
  $userToken = Get-Token -Email $UserEmail -Password $UserPassword
}

# 4) RBAC checks
if (-not $userToken) {
  Add-Result -Id "T4" -Name "RBAC/admin protection" -Status "SKIP" -Details "Missing user token."
} else {
  $adminAsUser = Invoke-Api -Method GET -Path "/api/admin/stats" -Headers @{ Authorization = "Bearer $userToken" }
  if ($adminAsUser.statusCode -eq 403) {
    $rbacDetails = "Regular user blocked from admin routes."
    $rbacStatus = "PASS"
  } else {
    $rbacDetails = "Regular user reached admin route with status $($adminAsUser.statusCode)."
    $rbacStatus = "FAIL"
  }

  $adminToken = Get-Token -Email $AdminEmail -Password $AdminPassword
  if ($adminToken) {
    $meAdmin = Invoke-Api -Method GET -Path "/api/auth/me" -Headers @{ Authorization = "Bearer $adminToken" }
    $adminId = $meAdmin.json.user.id
    $selfPatch = Invoke-Api -Method PATCH -Path "/api/admin/users/$adminId" -Headers @{ Authorization = "Bearer $adminToken" } -Body @{ is_active = $false }
    if ($selfPatch.statusCode -ne 400) {
      $rbacStatus = "FAIL"
      $rbacDetails += " Self-modification guard failed (status $($selfPatch.statusCode))."
    }
  } else {
    $rbacDetails += " Admin self-protection subtest skipped (missing admin creds)."
  }

  Add-Result -Id "T4" -Name "RBAC/admin protection" -Status $rbacStatus -Details $rbacDetails
}

# 5) IDOR / user isolation
$userBToken = Get-Token -Email $UserBEmail -Password $UserBPassword
if (-not $userToken -or -not $userBToken) {
  Add-Result -Id "T5" -Name "IDOR/isolation" -Status "SKIP" -Details "Provide valid A and B user creds."
} else {
  $addr = "So11111111111111111111111111111111111111112"
  [void](Invoke-Api -Method DELETE -Path "/api/config/tokens/$addr" -Headers @{ Authorization = "Bearer $userToken" })
  $addA = Invoke-Api -Method POST -Path "/api/config/tokens" -Headers @{ Authorization = "Bearer $userToken" } -Body @{ address = $addr; label = "isolation-test" }
  $cfgB = Invoke-Api -Method GET -Path "/api/config" -Headers @{ Authorization = "Bearer $userBToken" }
  [void](Invoke-Api -Method DELETE -Path "/api/config/tokens/$addr" -Headers @{ Authorization = "Bearer $userToken" })

  $seen = $false
  if ($cfgB.statusCode -eq 200 -and $cfgB.json -and $cfgB.json.tokens) {
    $seen = @($cfgB.json.tokens | Where-Object { $_.address -eq $addr }).Count -gt 0
  }

  if (($addA.statusCode -in 201,409) -and -not $seen) {
    Add-Result -Id "T5" -Name "IDOR/isolation" -Status "PASS" -Details "User B cannot see User A config token."
  } else {
    Add-Result -Id "T5" -Name "IDOR/isolation" -Status "FAIL" -Details "Isolation check failed or token operation failed."
  }
}

# 6) Input validation and injection handling
if (-not $userToken) {
  Add-Result -Id "T6" -Name "Input validation" -Status "SKIP" -Details "Missing user token."
} else {
  $sqli = Invoke-Api -Method POST -Path "/api/auth/login" -Body @{ email = "' OR 1=1 --"; password = "x" }
  $badCfgType = Invoke-Api -Method PATCH -Path "/api/config" -Headers @{ Authorization = "Bearer $userToken" } -Body @{ configs = @{ threshold = "abc" } }
  $badCfgRange = Invoke-Api -Method PATCH -Path "/api/config" -Headers @{ Authorization = "Bearer $userToken" } -Body @{ configs = @{ interval = -1 } }
  $badAddr = Invoke-Api -Method POST -Path "/api/config/tokens" -Headers @{ Authorization = "Bearer $userToken" } -Body @{ address = "not-an-address"; label = "x" }

  $ok = ($sqli.statusCode -ne 500) -and ($badCfgType.statusCode -eq 400) -and ($badCfgRange.statusCode -eq 400) -and ($badAddr.statusCode -eq 400)
  if ($ok) {
    Add-Result -Id "T6" -Name "Input validation" -Status "PASS" -Details "Malformed/suspicious payloads rejected safely."
  } else {
    Add-Result -Id "T6" -Name "Input validation" -Status "FAIL" -Details "Unexpected validation behavior. sqli=$($sqli.statusCode), cfgType=$($badCfgType.statusCode), cfgRange=$($badCfgRange.statusCode), badAddr=$($badAddr.statusCode)"
  }
}

# 7) CORS policy checks
$corsEvil = Invoke-Api -Method OPTIONS -Path "/api/auth/login" -Headers @{
  Origin = "http://evil.com"
  "Access-Control-Request-Method" = "POST"
  "Access-Control-Request-Headers" = "content-type"
}
$corsLocal = Invoke-Api -Method OPTIONS -Path "/api/auth/login" -Headers @{
  Origin = "http://localhost:3000"
  "Access-Control-Request-Method" = "POST"
  "Access-Control-Request-Headers" = "content-type"
}

$evilAcaOrigin = "$($corsEvil.headers['Access-Control-Allow-Origin'])"
$localAcaOrigin = "$($corsLocal.headers['Access-Control-Allow-Origin'])"
$evilBlocked = -not $evilAcaOrigin -or $evilAcaOrigin -ne "http://evil.com"
$localAllowed = ($corsLocal.statusCode -in 200,204) -and ($localAcaOrigin -eq "http://localhost:3000" -or $localAcaOrigin -eq "*")

if ($evilBlocked -and $localAllowed) {
  Add-Result -Id "T7" -Name "CORS policy" -Status "PASS" -Details "Untrusted origin blocked; trusted origin allowed."
} else {
  Add-Result -Id "T7" -Name "CORS policy" -Status "FAIL" -Details "CORS behavior unexpected. evil='$evilAcaOrigin', local='$localAcaOrigin'."
}

# 8) Rate limit (optional)
if (-not $RunRateLimit) {
  Add-Result -Id "T8" -Name "Rate limiting" -Status "SKIP" -Details "Use -RunRateLimit to execute."
} else {
  $codes = @()
  for ($i = 0; $i -lt $RateLimitRequests; $i++) {
    $r = Invoke-Api -Method GET -Path "/api/health"
    $codes += $r.statusCode
  }
  $hits429 = @($codes | Where-Object { $_ -eq 429 }).Count
  if ($hits429 -gt 0) {
    Add-Result -Id "T8" -Name "Rate limiting" -Status "PASS" -Details "Observed $hits429 responses with 429 in $RateLimitRequests requests."
  } else {
    Add-Result -Id "T8" -Name "Rate limiting" -Status "WARN" -Details "No 429 observed. Check limits/env or increase -RateLimitRequests."
  }
}

# 9) WebSocket auth hardening
$wsScript = @(
  'let io;',
  'try {',
  '  io = require("socket.io-client");',
  '} catch {',
  '  console.log("SKIP:socket.io-client not installed");',
  '  process.exit(2);',
  '}',
  'const socket = io("http://localhost:3000", {',
  '  transports: ["websocket"],',
  '  timeout: 5000,',
  '  auth: { token: "invalid.token.value" }',
  '});',
  'let connected = false;',
  'let errored = false;',
  'socket.on("connect", () => { connected = true; });',
  'socket.on("connect_error", (err) => {',
  '  errored = true;',
  '  console.log("ERR:" + (err && err.message ? err.message : "connect_error"));',
  '});',
  'setTimeout(() => {',
  '  socket.close();',
  '  if (connected) process.exit(1);',
  '  if (errored) process.exit(0);',
  '  process.exit(3);',
  '}, 4500);'
) -join "`n"

$tmpWs = Join-Path $env:TEMP "ws-auth-check.js"
Set-Content -Path $tmpWs -Value $wsScript -Encoding ASCII
$wsOutput = ""
$wsExit = 99
$oldNativeErrPref = $null
$hasNativeVar = $false
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $hasNativeVar = $true
  $oldNativeErrPref = $PSNativeCommandUseErrorActionPreference
  $PSNativeCommandUseErrorActionPreference = $false
}
try {
  $wsOutput = & node $tmpWs 2>&1
  $wsExit = $LASTEXITCODE
} catch {
  $wsOutput = $_.Exception.Message
  $wsExit = 98
} finally {
  if ($hasNativeVar) { $PSNativeCommandUseErrorActionPreference = $oldNativeErrPref }
}

if ($wsExit -eq 0) {
  Add-Result -Id "T9" -Name "WebSocket auth" -Status "PASS" -Details "Invalid token rejected on socket handshake."
} elseif ($wsExit -eq 2) {
  Add-Result -Id "T9" -Name "WebSocket auth" -Status "SKIP" -Details "socket.io-client is not installed."
} elseif ($wsExit -eq 98) {
  Add-Result -Id "T9" -Name "WebSocket auth" -Status "SKIP" -Details "Node execution failed in this environment. Output: $wsOutput"
} else {
  Add-Result -Id "T9" -Name "WebSocket auth" -Status "FAIL" -Details "Unexpected WebSocket auth result (exit $wsExit). Output: $wsOutput"
}

# 10) Basic stress (optional)
if (-not $RunStress) {
  Add-Result -Id "T10" -Name "Basic stress/DoS smoke" -Status "SKIP" -Details "Use -RunStress to execute."
} else {
  $jobs = @()
  for ($i = 0; $i -lt $StressRequests; $i++) {
    $jobs += Start-Job -ScriptBlock {
      param($b)
      try {
        Invoke-WebRequest -Uri "$b/api/health" -UseBasicParsing -TimeoutSec 5 | Out-Null
      } catch {}
    } -ArgumentList $BaseUrl
  }
  $null = Wait-Job -Job $jobs
  $jobs | Remove-Job -Force
  $afterStress = Invoke-Api -Method GET -Path "/api/health"
  if ($afterStress.statusCode -eq 200) {
    Add-Result -Id "T10" -Name "Basic stress/DoS smoke" -Status "PASS" -Details "Server still responsive after $StressRequests parallel requests."
  } elseif ($afterStress.statusCode -eq 429) {
    Add-Result -Id "T10" -Name "Basic stress/DoS smoke" -Status "PASS" -Details "Rate limiter engaged after stress (429), which is expected protection behavior."
  } else {
    Add-Result -Id "T10" -Name "Basic stress/DoS smoke" -Status "FAIL" -Details "Server unhealthy after stress (status $($afterStress.statusCode))."
  }
}

# 11) Dependency and secret hygiene
$npmAuditRaw = ""
$auditOk = $false
$auditWarn = ""
try {
  Push-Location $PSScriptRoot
  $npmAuditRaw = & npm audit --json 2>$null
  if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq 1) {
    $auditOk = $true
  } else {
    $auditWarn = "npm audit exited with code $LASTEXITCODE."
  }
} catch {
  $auditWarn = "npm audit failed: $($_.Exception.Message)"
} finally {
  Pop-Location
}

if ($auditOk) {
  try {
    $audit = $npmAuditRaw | ConvertFrom-Json
    $critical = 0
    $high = 0
    if ($audit.metadata -and $audit.metadata.vulnerabilities) {
      $critical = [int]$audit.metadata.vulnerabilities.critical
      $high = [int]$audit.metadata.vulnerabilities.high
    }
    if ($critical -gt 0 -or $high -gt 0) {
      Add-Result -Id "T11A" -Name "Dependency vulnerabilities" -Status "WARN" -Details "npm audit found high=$high critical=$critical."
    } else {
      Add-Result -Id "T11A" -Name "Dependency vulnerabilities" -Status "PASS" -Details "No high/critical vulnerabilities."
    }
  } catch {
    Add-Result -Id "T11A" -Name "Dependency vulnerabilities" -Status "WARN" -Details "Could not parse npm audit JSON."
  }
} else {
  Add-Result -Id "T11A" -Name "Dependency vulnerabilities" -Status "SKIP" -Details $auditWarn
}

$secretHits = @()
$patterns = @(
  'AKIA[0-9A-Z]{16}',
  '-----BEGIN (RSA|EC|OPENSSH|PRIVATE) KEY-----',
  '(?i)(api[_-]?key|secret|token)\\s*[:=]\\s*[A-Za-z0-9_\\-]{16,}'
)

Get-ChildItem -Path $PSScriptRoot -Recurse -File |
  Where-Object { $_.FullName -notmatch '\\node_modules\\' -and $_.Name -notin @('.env', 'package-lock.json') } |
  ForEach-Object {
    foreach ($pat in $patterns) {
      $hits = Select-String -Path $_.FullName -Pattern $pat -AllMatches -ErrorAction SilentlyContinue
      if ($hits) {
        $secretHits += $hits
        break
      }
    }
  }

if ($secretHits.Count -eq 0) {
  Add-Result -Id "T11B" -Name "Secret scan" -Status "PASS" -Details "No obvious secrets found outside excluded paths."
} else {
  $sample = ($secretHits | Select-Object -First 3 | ForEach-Object { "$($_.Path):$($_.LineNumber)" }) -join '; '
  Add-Result -Id "T11B" -Name "Secret scan" -Status "WARN" -Details "Potential secrets found ($($secretHits.Count) files). Sample: $sample"
}

# 12) Security headers
$healthUrl = "$BaseUrl/api/health"
$rawHeaders = ""
try {
  $rawHeaders = (& curl.exe -s -i $healthUrl | Out-String)
} catch {
  $rawHeaders = ""
}
$requiredHeaders = @(
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy"
)
$missing = @()
$headerText = $rawHeaders.ToLowerInvariant()
foreach ($key in $requiredHeaders) {
  if ($headerText -notmatch ("^" + [regex]::Escape($key) + ":") -and $headerText -notmatch ("`n" + [regex]::Escape($key) + ":")) {
    $missing += $key
  }
}
if ($missing.Count -eq 0) {
  Add-Result -Id "T12" -Name "Security headers" -Status "PASS" -Details "Helmet headers present."
} else {
  Add-Result -Id "T12" -Name "Security headers" -Status "WARN" -Details "Missing headers: $($missing -join ', ')"
}

# Report
$pass = @($results | Where-Object status -eq "PASS").Count
$fail = @($results | Where-Object status -eq "FAIL").Count
$warn = @($results | Where-Object status -eq "WARN").Count
$skip = @($results | Where-Object status -eq "SKIP").Count

Write-Host ""
Write-Host "== Results =="
$results | Format-Table -AutoSize
Write-Host ""
Write-Host "Summary: PASS=$pass FAIL=$fail WARN=$warn SKIP=$skip"

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  $ts = Get-Date -Format "yyyyMMdd-HHmmss"
  $OutputPath = Join-Path $PSScriptRoot "security-report-$ts.json"
}

$report = [pscustomobject]@{
  baseUrl    = $BaseUrl
  generatedAt = (Get-Date).ToString("o")
  summary    = [pscustomobject]@{
    pass = $pass
    fail = $fail
    warn = $warn
    skip = $skip
  }
  tests      = $results
}

$report | ConvertTo-Json -Depth 8 | Set-Content -Path $OutputPath -Encoding UTF8
Write-Host "Report saved to: $OutputPath"

