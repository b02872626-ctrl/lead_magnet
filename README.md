# Afriwork Hiring Guide

Simple landing page for collecting leads, emailing a PDF, and saving submissions to Google Sheets.

## What it does

- Serves the Afriwork hiring guide landing page.
- Captures lead details through a form.
- Saves every submission to `storage/leads.csv` in local development.
- Appends each submission to Google Sheets when configured.
- Generates a branded PDF on the server.
- Emails the PDF to the submitted address when SMTP is configured.
- Optionally notifies your team through `ADMIN_EMAIL`.

## Quick start

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env`.

3. Add your SMTP credentials and Google Sheets credentials.

4. Start the app:

   ```bash
   npm run dev
   ```

5. Open `http://localhost:3000`.

If port `3000` is busy on your machine, run with a different port:

```bash
$env:PORT=3010
npm run dev
```

## Email setup

The app sends the PDF using SMTP, so you can use Gmail, Outlook, Zoho, Mailgun, Brevo, or another email provider that gives SMTP access.

Required variables:

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`

Optional:

- `ADMIN_EMAIL`
- `GUIDE_DOWNLOAD_URL`

### Gmail example

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=youraddress@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM=Afriwork <youraddress@gmail.com>
ADMIN_EMAIL=you@yourcompany.com
```

For Gmail, use an App Password, not your main account password.

## Google Sheets setup

To save every form submission into Google Sheets:

1. Create a Google Sheet.
2. Copy the spreadsheet ID from the URL.
3. In Google Cloud, enable the Google Sheets API for your project.
4. Create a service account and download its JSON key.
5. Share the Google Sheet with the service account email as `Editor`.
6. Put the JSON key file in the project folder, for example as `google-service-account.json`.
7. Add these values to `.env`:

```env
GOOGLE_SHEETS_SPREADSHEET_ID=your_spreadsheet_id
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=./google-service-account.json
```

The app will create the header row automatically if the sheet tab is empty.

`GOOGLE_SHEETS_SHEET_NAME` is optional. If you leave it blank, the app will use the first tab in the spreadsheet.

### Alternative Google credentials

Instead of `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`, you can use either:

- `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_PRIVATE_KEY`
- `GOOGLE_SERVICE_ACCOUNT_JSON`

For Vercel, prefer `GOOGLE_SERVICE_ACCOUNT_JSON` in the project environment variables instead of uploading a key file.

## What happens on form submit

When someone submits the form, the server will:

1. Save the lead locally in `storage/leads.csv` when local file storage is enabled
2. Append the lead to Google Sheets if configured
3. Generate the PDF
4. Email the PDF to the lead if SMTP is configured
5. Add a browser download button when `GUIDE_DOWNLOAD_URL` is set, or when local download links are enabled

If SMTP or Google Sheets is missing, the app still returns a warning message instead of silently failing.

## Data storage

Local backup of all leads:

```text
storage/leads.csv
```

On Vercel, local disk is not persistent. The production-safe setup is:

- use Google Sheets as the lead store
- use SMTP for PDF delivery
- set `GUIDE_DOWNLOAD_URL` to a public Google Drive or hosted PDF link if you want a download button in the email
- keep `ENABLE_LOCAL_FILE_STORAGE` disabled
- keep `ENABLE_DOWNLOAD_LINKS` disabled unless you move PDFs to durable storage like Vercel Blob, S3, or Cloudflare R2

## Deploying to Vercel

1. Import the GitHub repo into Vercel.
2. Add these environment variables in the Vercel project:
   - `SMTP_HOST`
   - `SMTP_PORT`
   - `SMTP_SECURE`
   - `SMTP_USER`
   - `SMTP_PASS`
   - `SMTP_FROM`
   - `ADMIN_EMAIL` optional
   - `GUIDE_DOWNLOAD_URL` optional
   - `GOOGLE_SHEETS_SPREADSHEET_ID`
   - `GOOGLE_SHEETS_SHEET_NAME` optional
   - `GOOGLE_SERVICE_ACCOUNT_JSON`
3. Redeploy after saving the variables.

The repo includes `api/[...route].js` so `/api/leads` and `/api/health` run as Vercel Functions, while the landing page is served statically from `public/`.

## Customizing the PDF

The PDF is generated in `server.js` by `generateLeadMagnetPdf()`.

If you already have a finished PDF file you want to send instead, replace the generated buffer in `sendLeadMagnet()` with a file attachment read from disk.
