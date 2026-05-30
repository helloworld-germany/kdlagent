# scripts/eval-classify.ps1
# Evaluation des /api/classify Endpoints gegen den KDL-Goldstandard.
#
# Format pro Zeile in tests/eval/kdl-gold.jsonl:
#   { "id":"...", "category":"...", "text":"...", "expected_codes":["AD010104", ...], "notes":"..." }
#
# Set-basierte Metriken (Precision/Recall/F1, Exact, Primary-Hit) auf drei
# KDL-Hierarchie-Ebenen:
#   - Leaf      (8 Zeichen, z. B. AD010104  Entlassungsbericht extern)
#   - Sub-Klasse (6 Zeichen, z. B. AD0101    Arztberichte)
#   - Klasse    (2 Zeichen, z. B. AD        Arztdokumentation)
#
# Zusätzlich: verified-Rate, Disagreement-Recovery, Confidence-Calibration.
#
# Aufruf:
#   ./scripts/eval-classify.ps1 -BaseUrl https://func-kdl-kdlavis.azurewebsites.net `
#                               -ResourceGroup rg-kdl-classifier `
#                               -FunctionApp func-kdl-kdlavis

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $BaseUrl,
    [string] $Key,
    [string] $ResourceGroup,
    [string] $FunctionApp,
    [string] $GoldFile = "$PSScriptRoot/../tests/eval/kdl-gold.jsonl",
    [string] $ReportDir = "$PSScriptRoot/../tests/eval/reports",
    [int] $TimeoutSec = 180,
    [int] $DelayMs = 1500,
    [int] $MaxRetries = 5,
    [string] $LanguageHint = 'de'
)

$ErrorActionPreference = 'Stop'

if (-not $Key) {
    if (-not ($ResourceGroup -and $FunctionApp)) {
        throw "Provide -Key or both -ResourceGroup and -FunctionApp."
    }
    $Key = az functionapp keys list -g $ResourceGroup -n $FunctionApp --query functionKeys.default -o tsv
    if (-not $Key) { throw "Failed to fetch function key via az." }
}

if (-not (Test-Path $GoldFile)) { throw "Gold file not found: $GoldFile" }
$null = New-Item -ItemType Directory -Force -Path $ReportDir

function Get-Leaf  { param([string]$c) ($c -replace '\s','').ToUpper() }
function Get-Sub   { param([string]$c) $l = Get-Leaf $c; if ($l.Length -ge 6) { $l.Substring(0,6) } else { $l } }
function Get-Class { param([string]$c) $l = Get-Leaf $c; if ($l.Length -ge 2) { $l.Substring(0,2) } else { $l } }

function Score-Set {
    param([string[]] $Predicted, [string[]] $Expected)
    $p = @($Predicted | Where-Object { $_ } | Sort-Object -Unique)
    $e = @($Expected  | Where-Object { $_ } | Sort-Object -Unique)
    $tp = @($p | Where-Object { $e -contains $_ }).Count
    $precision = if ($p.Count) { $tp / $p.Count } else { 0.0 }
    $recall    = if ($e.Count) { $tp / $e.Count } else { 0.0 }
    $f1 = if (($precision + $recall) -gt 0) { 2 * $precision * $recall / ($precision + $recall) } else { 0.0 }
    $exact = ($p.Count -eq $e.Count -and $tp -eq $e.Count)
    return [pscustomobject]@{
        TP = $tp; Precision = $precision; Recall = $recall; F1 = $f1; Exact = $exact
        Missing = @($e | Where-Object { $p -notcontains $_ })
        Extra   = @($p | Where-Object { $e -notcontains $_ })
    }
}

$cases = Get-Content -Path $GoldFile -Encoding UTF8 | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json }
Write-Host "Loaded $($cases.Count) gold cases from $GoldFile" -ForegroundColor Cyan
Write-Host "Target: $BaseUrl" -ForegroundColor Cyan

$results = New-Object System.Collections.Generic.List[object]
$idx = 0
foreach ($case in $cases) {
    $idx++
    Write-Host "[$idx/$($cases.Count)] $($case.id) ($($case.category))" -ForegroundColor Yellow
    $body = @{ text = $case.text } | ConvertTo-Json -Depth 5 -Compress
    $url = "$BaseUrl/api/classify?code=$Key&languageHint=$LanguageHint"

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $resp = $null
    $lastErr = $null
    for ($attempt = 1; $attempt -le $MaxRetries; $attempt++) {
        try {
            $resp = Invoke-RestMethod -Uri $url -Method Post -Body $body -ContentType 'application/json; charset=utf-8' -TimeoutSec $TimeoutSec
            $lastErr = $null
            break
        } catch {
            $lastErr = $_
            $status = $null
            try { $status = [int]$_.Exception.Response.StatusCode } catch { }
            $retryable = ($status -eq 429) -or ($status -ge 500) -or (-not $status)
            if (-not $retryable -or $attempt -eq $MaxRetries) { break }
            $backoff = [int]([math]::Min(30000, 1000 * [math]::Pow(2, $attempt)))
            Write-Host "  attempt $attempt failed (status=$status). backing off $backoff ms" -ForegroundColor DarkYellow
            Start-Sleep -Milliseconds $backoff
        }
    }
    $sw.Stop()
    if ($null -eq $resp) {
        Write-Host "  ERROR: $($lastErr.Exception.Message)" -ForegroundColor Red
        $results.Add([pscustomobject]@{
            id = $case.id; category = $case.category; ok = $false; error = $lastErr.Exception.Message
        })
        Start-Sleep -Milliseconds $DelayMs
        continue
    }

    $classifications = @()
    if ($resp.classifications) { $classifications = @($resp.classifications) }

    $predLeaf = @($classifications | ForEach-Object { Get-Leaf $_.code } | Where-Object { $_ })
    $expLeaf  = @($case.expected_codes | ForEach-Object { Get-Leaf $_ })

    $predSub  = @($predLeaf | ForEach-Object { Get-Sub  $_ } | Sort-Object -Unique)
    $expSub   = @($expLeaf  | ForEach-Object { Get-Sub  $_ } | Sort-Object -Unique)

    $predCls  = @($predLeaf | ForEach-Object { Get-Class $_ } | Sort-Object -Unique)
    $expCls   = @($expLeaf  | ForEach-Object { Get-Class $_ } | Sort-Object -Unique)

    $leaf  = Score-Set -Predicted $predLeaf -Expected $expLeaf
    $sub   = Score-Set -Predicted $predSub  -Expected $expSub
    $class = Score-Set -Predicted $predCls  -Expected $expCls
    $primaryHit = ($expLeaf.Count -gt 0) -and ($predLeaf -contains $expLeaf[0])

    # KDL-spezifische Zusatz-Metriken
    $verifiedCount = @($classifications | Where-Object { $_.verified }).Count
    $disagreeCount = @($classifications | Where-Object { $_.verificationMethod -eq 'dual-call-disagree' }).Count
    $avgConfidence = if ($classifications.Count) {
        ($classifications | Measure-Object -Property confidence -Average).Average
    } else { 0 }
    # Wenn dual-call-disagree: war die *gewählte* (höhere Confidence) Variante korrekt?
    $disagreeRecovered = 0
    foreach ($cl in $classifications) {
        if ($cl.verificationMethod -eq 'dual-call-disagree') {
            if ($expLeaf -contains (Get-Leaf $cl.code)) { $disagreeRecovered++ }
        }
    }

    Write-Host ("  expected: {0}" -f ($expLeaf -join ', '))
    Write-Host ("  predicted: {0}" -f ($predLeaf -join ', '))
    Write-Host ("  F1 leaf={0:N2}  sub={1:N2}  class={2:N2}  primary={3}  verified={4}/{5}  conf={6:N2}  {7:N1}s" `
        -f $leaf.F1, $sub.F1, $class.F1, $primaryHit, $verifiedCount, $classifications.Count, $avgConfidence, $sw.Elapsed.TotalSeconds) -ForegroundColor Green

    $results.Add([pscustomobject]@{
        id            = $case.id
        category      = $case.category
        ok            = $true
        expected      = $expLeaf
        predicted     = $predLeaf
        leaf          = $leaf
        sub           = $sub
        class         = $class
        primaryHit    = $primaryHit
        nClassif      = $classifications.Count
        verifiedCount = $verifiedCount
        disagreeCount = $disagreeCount
        disagreeRecov = $disagreeRecovered
        avgConfidence = [math]::Round($avgConfidence, 3)
        durationSec   = [math]::Round($sw.Elapsed.TotalSeconds, 2)
    })
    Start-Sleep -Milliseconds $DelayMs
}

$ok = $results | Where-Object { $_.ok }
$n = $ok.Count
if ($n -eq 0) { throw "No successful classifications to summarize." }

function Avg($values) { if ($values.Count) { ($values | Measure-Object -Average).Average } else { 0 } }

$totalClassif    = ($ok | Measure-Object -Property nClassif -Sum).Sum
$totalVerified   = ($ok | Measure-Object -Property verifiedCount -Sum).Sum
$totalDisagree   = ($ok | Measure-Object -Property disagreeCount -Sum).Sum
$totalRecovered  = ($ok | Measure-Object -Property disagreeRecov -Sum).Sum

$summary = [pscustomobject]@{
    baseUrl            = $BaseUrl
    goldFile           = (Resolve-Path $GoldFile).Path
    timestamp          = (Get-Date).ToString('o')
    cases              = $cases.Count
    succeeded          = $n
    exactSetMatchLeaf  = ($ok | Where-Object { $_.leaf.Exact }).Count
    primaryHit         = ($ok | Where-Object { $_.primaryHit }).Count
    avgPrecisionLeaf   = [math]::Round((Avg ($ok | ForEach-Object { $_.leaf.Precision })), 3)
    avgRecallLeaf      = [math]::Round((Avg ($ok | ForEach-Object { $_.leaf.Recall })),    3)
    avgF1Leaf          = [math]::Round((Avg ($ok | ForEach-Object { $_.leaf.F1 })),        3)
    avgPrecisionSub    = [math]::Round((Avg ($ok | ForEach-Object { $_.sub.Precision })),  3)
    avgRecallSub       = [math]::Round((Avg ($ok | ForEach-Object { $_.sub.Recall })),     3)
    avgF1Sub           = [math]::Round((Avg ($ok | ForEach-Object { $_.sub.F1 })),         3)
    avgPrecisionClass  = [math]::Round((Avg ($ok | ForEach-Object { $_.class.Precision })), 3)
    avgRecallClass     = [math]::Round((Avg ($ok | ForEach-Object { $_.class.Recall })),    3)
    avgF1Class         = [math]::Round((Avg ($ok | ForEach-Object { $_.class.F1 })),        3)
    totalClassifications  = $totalClassif
    verifiedRate          = if ($totalClassif) { [math]::Round($totalVerified / $totalClassif, 3) } else { 0 }
    disagreementRate      = if ($totalClassif) { [math]::Round($totalDisagree / $totalClassif, 3) } else { 0 }
    disagreementRecovered = if ($totalDisagree) { [math]::Round($totalRecovered / $totalDisagree, 3) } else { 0 }
    avgConfidence         = [math]::Round((Avg ($ok | ForEach-Object { $_.avgConfidence })), 3)
    avgDurationSec        = [math]::Round((Avg ($ok | ForEach-Object { $_.durationSec })),    2)
}

Write-Host "`n=== Summary ===" -ForegroundColor Cyan
$summary | Format-List

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$jsonPath = Join-Path $ReportDir "eval-kdl-$stamp.json"
$mdPath   = Join-Path $ReportDir "eval-kdl-$stamp.md"

$payload = [pscustomobject]@{ summary = $summary; results = $results }
$payload | ConvertTo-Json -Depth 10 | Set-Content -Path $jsonPath -Encoding UTF8

$md = New-Object System.Text.StringBuilder
[void]$md.AppendLine("# KDL Eval Report")
[void]$md.AppendLine("")
[void]$md.AppendLine("- Timestamp: $($summary.timestamp)")
[void]$md.AppendLine("- Base URL: $($summary.baseUrl)")
[void]$md.AppendLine("- Gold file: ``$($summary.goldFile)``")
[void]$md.AppendLine("- Cases: $($summary.cases)  /  Succeeded: $($summary.succeeded)")
[void]$md.AppendLine("")
[void]$md.AppendLine("## Aggregate metrics (set-based, hierarchy levels)")
[void]$md.AppendLine("")
[void]$md.AppendLine("| Metrik | Leaf (8) | Sub-Klasse (6) | Klasse (2) |")
[void]$md.AppendLine("|---|---:|---:|---:|")
[void]$md.AppendLine("| Avg Precision | $($summary.avgPrecisionLeaf) | $($summary.avgPrecisionSub) | $($summary.avgPrecisionClass) |")
[void]$md.AppendLine("| Avg Recall    | $($summary.avgRecallLeaf)    | $($summary.avgRecallSub)    | $($summary.avgRecallClass)    |")
[void]$md.AppendLine("| Avg F1        | $($summary.avgF1Leaf)        | $($summary.avgF1Sub)        | $($summary.avgF1Class)        |")
[void]$md.AppendLine("")
[void]$md.AppendLine("- Exact set match (Leaf): **$($summary.exactSetMatchLeaf) / $n**")
[void]$md.AppendLine("- Primary-code hit: **$($summary.primaryHit) / $n**")
[void]$md.AppendLine("- Avg duration: $($summary.avgDurationSec) s")
[void]$md.AppendLine("")
[void]$md.AppendLine("## Dual-Call-Verifikation")
[void]$md.AppendLine("")
[void]$md.AppendLine("- Klassifikationen gesamt: **$($summary.totalClassifications)** (über alle Seiten/Cases)")
[void]$md.AppendLine("- verified-Rate (dual-call agree): **$([math]::Round($summary.verifiedRate*100,1)) %**")
[void]$md.AppendLine("- Disagreement-Rate: **$([math]::Round($summary.disagreementRate*100,1)) %**")
[void]$md.AppendLine("- Disagreement-Recovery (gewählte Variante war korrekt): **$([math]::Round($summary.disagreementRecovered*100,1)) %**")
[void]$md.AppendLine("- Avg Confidence: **$($summary.avgConfidence)**")
[void]$md.AppendLine("")
[void]$md.AppendLine("## Per-case results")
[void]$md.AppendLine("")
[void]$md.AppendLine("| ID | Kategorie | Expected | Predicted | F1 Leaf | F1 Sub | F1 Klasse | Exact | Primary | Verif. |")
[void]$md.AppendLine("|---|---|---|---|---:|---:|---:|:---:|:---:|---|")
foreach ($r in $ok) {
    $exp = ($r.expected -join ', ')
    $prd = ($r.predicted -join ', ')
    [void]$md.AppendLine(("| {0} | {1} | {2} | {3} | {4:N2} | {5:N2} | {6:N2} | {7} | {8} | {9}/{10} |" -f `
        $r.id, $r.category, $exp, $prd, $r.leaf.F1, $r.sub.F1, $r.class.F1,
        ($(if ($r.leaf.Exact) { '✔' } else { '·' })),
        ($(if ($r.primaryHit) { '✔' } else { '·' })),
        $r.verifiedCount, $r.nClassif))
}

Set-Content -Path $mdPath -Value $md.ToString() -Encoding UTF8

Write-Host "`nWrote:" -ForegroundColor Cyan
Write-Host "  $jsonPath"
Write-Host "  $mdPath"
