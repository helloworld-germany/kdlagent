# KDL Classifier

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fhelloworld-germany%2Fkdlagent%2Fmain%2Finfra%2Fmain.json/uiFormDefinitionUri/https%3A%2F%2Fraw.githubusercontent.com%2Fhelloworld-germany%2Fkdlagent%2Fmain%2Finfra%2FuiFormDefinition.json)

> Infrastruktur als Code: [`infra/main.bicep`](infra/main.bicep) — lokal visualisierbar via VS Code Befehl `Bicep: Open Visualizer`.

> **1-Click Deployment**: Klick auf den blauen Button öffnet das Azure-Portal mit einem geführten Wizard. Alle Ressourcen werden in **Ihrem Tenant** angelegt, Authentifizierung läuft ausschließlich über **Managed Identity + RBAC**, Storage hängt an einem dedizierten **VNet mit Private Endpoints**. Keine Connection-Strings, keine Shared Keys.

Azure **Function App** zur Klassifikation klinischer Dokumente (Text, PDFs, Bilder, Audio) gegen die [**DVMD KDL CodeSystem**](http://dvmd.de/fhir/CodeSystem/kdl) — *Klinische Dokumentenklassen-Liste* — Seite für Seite, mit Dual-Call GPT-Verifikation.

- **557 KDL-Codes** (13 Klassen → 64 Sub-Klassen → 480 Leaf-Codes), live aus der DVMD-FHIR-Package-Registry (`dvmd.kdl.r4`) gecached, mit gebündeltem Fallback.
- **Dual-Call-Verifikation**: zwei parallele GPT-Aufrufe pro Dokument (context-aware + independent), Agreement → `verified: true`, Disagreement → höhere Confidence gewinnt + beide Opinions transparent.
- **Multi-Modal**: Text direkt, Bilder/PDFs über Azure AI Vision Read, Audio über Azure AI Speech.

---

## 1-Click-Deployment — Voraussetzungen & Ablauf

### Vor dem Klick

| Was | Wie prüfen / einrichten |
|---|---|
| **Azure-Subscription** mit Rechten auf Subscription-Ebene (`Owner` oder `Contributor + User Access Administrator`) | Portal → *Subscriptions → Access control (IAM)*. Ohne diese Rolle scheitert das Subscription-scoped Deployment, weil RBAC-Rollen angelegt werden. |
| **Azure-OpenAI-Quota** für das gewünschte Modell in der gewählten Region | [AOAI Quotas & Limits](https://learn.microsoft.com/azure/ai-services/openai/quotas-limits). Standard: `gpt-5.4-mini` / 50k TPM. Bei zu wenig Quota: Wizard-Slider runterdrehen oder anderes Modell wählen. |

### Klick & Wizard

1. Auf **Deploy to Azure** klicken.
2. Subscription + (neue) Resource Group + Region wählen.
3. `nameSuffix` setzen (3-8 lowercase, eindeutig — z. B. `klinik1`).
4. **AOAI-Tab**: Modell + Capacity an Ihre Quota anpassen.
5. **Code-Tab**: Package-URL stehen lassen (= GitHub-Release-ZIP) oder leeren, um den Code später per `deploy.ps1 -SkipInfra` zu publishen.
6. *Review + create*. Deployment-Dauer: ~10-15 Min.

### Nach dem Deployment

```powershell
# Function Key abrufen
az functionapp function keys list -g <RG> -n func-kdl-<suffix> --function-name classify --query default -o tsv

# Smoke-Test
curl -X POST "https://func-kdl-<suffix>.azurewebsites.net/api/classify?code=<KEY>" `
  -H "Content-Type: application/json" `
  -d '{"text":"CT-Befund Schädel mit Kontrastmittel"}'

# UI öffnen (anonym)
start https://func-kdl-<suffix>.azurewebsites.net/api/debug
```

---

## Für Newcomer: "Meine erste Azure Landing Zone"

Wenn Sie **noch nie etwas in Azure deployed haben**, sollten Sie *vor* dem 1-Click-Button einmalig eine minimale Landing Zone einrichten. Microsoft liefert Blaupausen:

| Szenario | Pfad | Aufwand |
|---|---|---|
| **Solo-Klinik / kleine Praxis** | [Azure Setup Guide (Quick)](https://learn.microsoft.com/azure/cloud-adoption-framework/ready/azure-setup-guide/) | < 1 h |
| **Kleines Krankenhaus** — Sandbox + Prod, Cost Alerts | [Azure Landing Zone Accelerator](https://learn.microsoft.com/azure/cloud-adoption-framework/ready/landing-zone/sovereign/sovereign-landing-zone-portal-deployment-guide) | 2-4 h |
| **Klinik-Verbund / Konzern** — Hub-Spoke, ExpressRoute | [Enterprise-Scale Landing Zone (ALZ)](https://github.com/Azure/Enterprise-Scale) | 1-2 Tage |
| **Souveränität & BSI/KRITIS** | [Sovereign Landing Zone](https://github.com/Azure/sovereign-landing-zone) | 1-3 Tage |

Pflicht-Bausteine vor produktivem Patientendaten-Workload:

1. **Microsoft Entra ID Tenant** mit MFA für alle Admins.
2. **Cost Management Budget** (Alert bei z. B. 100 € / Monat).
3. **Microsoft Defender for Cloud** (Free Tier reicht zum Start).
4. **Diagnostic Settings → Log Analytics Workspace** (zentral).
5. **Tagging-Policy** (`owner`, `costCenter`, `dataClassification`).

Weiterführend: [Cloud Adoption Framework](https://learn.microsoft.com/azure/cloud-adoption-framework/) · [BSI C5 & Azure](https://learn.microsoft.com/compliance/regulatory/offering-c5-germany) · [Azure Health Data Services](https://learn.microsoft.com/azure/healthcare-apis/).

---

## Architektur

```
                             ┌──────────────────────────┐
  Event Grid topic           │                          │
  vidaugment.moments.extracted──► classifyMoments       │
                             │    (Event Grid Trigger)  │
                             │         │                │   vidaugment.kdl.classified
  POST /api/classify         │         ▼                ├──► Event Grid topic
  { text | moments | file }──►│  shared/classifyGpt.js  │
                             │    (GPT Dual-Call)       │
  POST /api/classify         │         ▲                │
  Content-Type: image/*  ────►│  shared/extract.js      │
  Content-Type: audio/*      │  (Vision / Speech / DI) │
  Content-Type: application/pdf       │                 │
                             └──────────────────────────┘
```

## Functions

| Function | Trigger | Beschreibung |
|---|---|---|
| `classify` | HTTP POST `/api/classify` | On-demand Klassifikation (Text, Files, Moments) |
| `classifyMoments` | Event Grid (`vidaugment.moments.extracted`) | Klassifiziert und re-publisht |
| `debug` | HTTP GET `/api/debug` | Interaktive Debug-Konsole |

## HTTP API

`/api/classify` benötigt einen **Function Key** (`?code=...`).

```bash
# Plain text
curl -X POST "https://<host>/api/classify?code=KEY&languageHint=de" \
  -H "Content-Type: application/json" \
  -d '{"text":"CT-Befund Schädel mit Kontrastmittel"}'

# Moments array
curl -X POST "https://<host>/api/classify?code=KEY" \
  -H "Content-Type: application/json" \
  -d '{"moments":[{"text":"CT-Befund Schädel","page":1}]}'

# Base64-encoded PDF
curl -X POST "https://<host>/api/classify?code=KEY&languageHint=de" \
  -H "Content-Type: application/json" \
  -d "{\"file\":\"$(base64 -w0 document.pdf)\",\"fileContentType\":\"application/pdf\"}"
```

Response (gekürzt):
```json
{
  "classifications": [
    {
      "page": 1,
      "code": "DG020103",
      "display": "CT-Befund",
      "classId": "DG",
      "confidence": 0.95,
      "verified": true,
      "verificationMethod": "dual-call-agree"
    }
  ],
  "codeSystem": {
    "url": "http://dvmd.de/fhir/CodeSystem/kdl",
    "version": "2025",
    "publisher": "DVMD",
    "codeCount": 480
  },
  "inputType": "pdf"
}
```

## Supported file types

| Typ | Content-Types | Azure-AI-Dienst |
|---|---|---|
| Bilder | `image/jpeg`, `image/png`, `image/tiff`, `image/bmp`, `image/webp` | Vision v4.0 Image Analysis |
| PDFs | `application/pdf` | Vision v3.2 Read (async, multi-page) |
| Audio | `audio/wav`, `audio/mpeg`, `audio/ogg`, `audio/flac` | Speech fast transcription |

## Local Development

```bash
npm install
func start
```

Erfordert `local.settings.json` mit:

| Setting | Wofür |
|---|---|
| `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_DEPLOYMENT` | Klassifikation |
| `AZURE_AI_VISION_ENDPOINT` | Bilder/PDFs |
| `AZURE_AI_SPEECH_ENDPOINT` | Audio |
| `EVENT_GRID_TOPIC_ENDPOINT` | Event-Grid-Modus (optional) |

Auth via `DefaultAzureCredential` (Managed Identity in Azure, `az login` lokal).

## Projektstruktur

```
classify/           HTTP POST /api/classify
classifyMoments/    Event Grid Trigger
config/             Gebündelter KDL-CodeSystem-Fallback
debug/              Debug-Konsole
infra/              Bicep + ARM + uiFormDefinition.json
schemas/            JSON Schema für Event-Grid-Events
scripts/            eval-classify.ps1 (Validierungs-Runner)
shared/             classifyGpt.js, extract.js, eventGrid.js, kdlCodeSystem.js
tests/eval/         Synthetisches Gold-Set + Reports
```

## Validierung

Synthetisches Mini-Gold-Set ([`tests/eval/kdl-gold.jsonl`](tests/eval/kdl-gold.jsonl)) mit **32 Fällen** über **alle 13 KDL-Hauptklassen** (inkl. 1 Multi-Page-Dokument). Evaluiert wird gegen das live geladene `dvmd.kdl.r4`-CodeSystem.

Skript: [`scripts/eval-classify.ps1`](scripts/eval-classify.ps1) — postet jede Probe an `POST /api/classify`, bewertet Precision/Recall/F1 auf **drei Hierarchie-Ebenen** (Leaf 8-stellig · Sub-Klasse 6-stellig · Klasse 2-stellig) plus Dual-Call-Metriken.

### Ergebnis (Run 2026-05-29, `gpt-5.4-mini` zero-shot, n=32)

| Ebene | Avg Precision | Avg Recall | **Avg F1** |
|---|---:|---:|---:|
| **Leaf** (8-stellig, z. B. `AD010104`) | 0.75 | 0.75 | **0.75** |
| **Sub-Klasse** (6-stellig, z. B. `AD0101`) | 0.94 | 0.94 | **0.94** |
| **Klasse** (2-stellig, z. B. `AD`) | 0.94 | 0.94 | **0.94** |

- Exact-Set-Match (Leaf): **24/32 (75 %)**
- Primary-Code-Hit: **24/32 (75 %)**
- Dual-Call **verified-Rate**: **100 %** (alle parallelen Calls einig)
- ⌀ Confidence: **0.99**  ·  ⌀ Latenz: **1.4 s/Fall**

### Interpretation & Caveats

- **Hohe Klassen-/Sub-Klassen-Treffer** (94 % F1) zeigen: das Modell erkennt den Dokumenttyp zuverlässig grob. Verwechslungen passieren primär *innerhalb* einer Sub-Klasse (z. B. `AD010115` *Entlassungsbericht* vs. `AD010104` *Entlassungsbericht extern*).
- **Synthetic-Bias**: die 32 Testtexte sind kurz und prototypisch. Echte Krankenhausdokumente sind länger, fehlerhaft OCRed, mehrsprachig — F1 auf Leaf-Ebene wird in der Praxis niedriger liegen.
- **Versionsdrift**: einige Gold-Codes stammen aus dem gebündelten Fallback; live geladene Codes können abweichen. Sub-Klassen/Klassen sind stabiler.
- **Kein Vergleich zu Literatur** — Stand der Wissenschaft (Mai 2026): wir kennen keine publizierte automatisierte KDL-Klassifikations-Benchmark. Wer eine hat: bitte PR.
- **Vollständig synthetisch**: alle 32 Testtexte wurden generiert; kein realer Patientenbezug, keine PHI im Repo.

### Reproduktion

```powershell
# Voraussetzung: deployte Function App + AOAI-Quota >= 100k TPM für 32 Dual-Calls
./scripts/eval-classify.ps1 `
  -BaseUrl 'https://func-kdl-<suffix>.azurewebsites.net' `
  -ResourceGroup 'rg-kdl-<suffix>' `
  -FunctionApp 'func-kdl-<suffix>'
# → tests/eval/reports/eval-kdl-<timestamp>.{json,md}
```

### Kostenabschätzung pro Call (Stand 05/2026, `gpt-5.4-mini` GlobalStandard)

**Token-Budget pro GPT-Call** (gemessen aus [`shared/kdlCodeSystem.js`](shared/kdlCodeSystem.js) + [`shared/classifyGpt.js`](shared/classifyGpt.js)):

| Komponente | ca. Tokens |
|---|---:|
| KDL-Codeliste (480 Codes × ~22 Tokens) | ~10.500 |
| System-Prompt + Format-Instruktionen | ~250 |
| Seiten-Text (Mittelwert klin. Dokument, ~1.500 Zeichen) | ~500 |
| Output (JSON-Antwort, 1 Seite) | ~150 |
| **Input gesamt / Call** | **~11.250** |
| **Output gesamt / Call** | **~150** |

**Listenpreis** Azure OpenAI `gpt-5.4-mini` GlobalStandard (Sweden Central, Mai 2026, [aka.ms/aoaipricing](https://azure.microsoft.com/pricing/details/cognitive-services/openai-service/)):

| Token-Typ | $ / 1M Tokens |
|---|---:|
| Input | ~$0,15 |
| Output | ~$0,60 |

> Preise variieren je Region/SKU und ändern sich regelmäßig — bitte aktuelle Werte im Azure-Pricing-Rechner prüfen.

**Kosten pro klassifiziertem Dokument**:

| Dokument-Typ | GPT-Calls | Input-Tk | Output-Tk | **Kosten** |
|---|:--:|---:|---:|---:|
| 1-Seiter (Single-Call, kein Dual) | 1 | 11.250 | 150 | **~$0,0018** |
| 1-Seiter mit Dual-Call¹ | 2 | 22.500 | 300 | **~$0,0036** |
| 3-Seiter (Dual-Call) | 2 | 23.500 | 900 | **~$0,0041** |
| 10-Seiter (Dual-Call) | 2 | 27.000 | 3.000 | **~$0,0059** |
| 50-Seiter (Dual-Call, Max) | 2 | 47.000 | 12.000 | **~$0,0143** |

¹ *Aktueller Code: Single-Page-Dokumente überspringen Dual-Call (siehe [`classifyGpt.js`](shared/classifyGpt.js#L89)).*

**Zusätzliche Azure-Kosten** (nicht in obiger Tabelle):
- **Document Intelligence** `prebuilt-read`: ~$1,50 / 1.000 Seiten → ~$0,0015/Seite
- **AI Vision Read** (bei Bildern): ~$1,50 / 1.000 Transaktionen
- **AI Speech transcribe** (bei Audio): ~$1,00 / Stunde
- **Function App EP1**: Fixkosten ~$180/Monat (egal wie viele Calls)
- **Storage / Private Endpoint**: ~$10-15/Monat

**Faustregel für 10.000 PDF-Dokumente à 5 Seiten**:
- GPT: 10.000 × $0,0045 ≈ **$45**
- DocIntelligence: 50.000 × $0,0015 ≈ **$75**
- Function/Storage Fixkosten/Monat: ~$200
- **Gesamt: ~$320 / 10k Docs** (variable Kosten dominieren ab ~15-20k Docs/Monat)

**Eval-Run-Kosten** (n=32, fast alle Single-Page): ≈ 33 Calls × $0,0018 ≈ **$0,06**.

## License

MIT — siehe [LICENSE](LICENSE).
