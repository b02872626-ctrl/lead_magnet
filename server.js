const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const dotenv = require("dotenv");
const express = require("express");
const { google } = require("googleapis");
const nodemailer = require("nodemailer");
const PDFDocument = require("pdfkit");

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const IS_VERCEL = process.env.VERCEL === "1" || process.env.VERCEL === "true";
const ENABLE_LOCAL_FILE_STORAGE = getBooleanEnv("ENABLE_LOCAL_FILE_STORAGE", !IS_VERCEL);
const ENABLE_DOWNLOAD_LINKS = getBooleanEnv(
  "ENABLE_DOWNLOAD_LINKS",
  ENABLE_LOCAL_FILE_STORAGE && !IS_VERCEL
);
const GUIDE_DOWNLOAD_URL = normalizeGuideDownloadUrl(process.env.GUIDE_DOWNLOAD_URL);
const STORAGE_DIR = path.join(__dirname, "storage");
const LEADS_CSV_PATH = path.join(STORAGE_DIR, "leads.csv");
const DOWNLOADS_DIR = path.join(STORAGE_DIR, "downloads");
const EMAIL_LOGO_PATH = path.join(__dirname, "public", "assets", "logo-afriwork.svg");
const fieldOrder = [
  "submittedAt",
  "fullName",
  "companyName",
  "email",
  "phone",
  "companyScale",
  "position",
];

let cachedTransporter = null;
let cachedSheetsClient = null;

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/download/:token", async (req, res) => {
  if (!ENABLE_DOWNLOAD_LINKS) {
    return res.status(404).send("File not found.");
  }

  const token = sanitizeDownloadToken(req.params.token);

  if (!token) {
    return res.status(404).send("File not found.");
  }

  const filePath = path.join(DOWNLOADS_DIR, `${token}.pdf`);

  try {
    await fsp.access(filePath, fs.constants.R_OK);
    return res.download(filePath, "afriwork-hiring-guide.pdf");
  } catch {
    return res.status(404).send("File not found.");
  }
});

app.post("/api/leads", async (req, res) => {
  const lead = normalizeLead(req.body);
  const validationError = validateLead(lead);

  if (validationError) {
    return res.status(400).json({
      ok: false,
      message: validationError,
    });
  }

  const record = {
    submittedAt: new Date().toISOString(),
    ...lead,
  };

  try {
    if (ENABLE_LOCAL_FILE_STORAGE) {
      await appendLeadToCsv(record);
    }

    const sheetResult = await syncLeadToGoogleSheets(record);
    const pdfBuffer = await generateLeadMagnetPdf(record);
    const downloadUrl =
      GUIDE_DOWNLOAD_URL ||
      (ENABLE_DOWNLOAD_LINKS ? await createDownloadLink(req, pdfBuffer) : null);

    let emailResult = {
      emailSent: false,
      configured: false,
    };

    try {
      emailResult = await sendLeadMagnet(record, pdfBuffer, downloadUrl);
    } catch (emailError) {
      console.error("Email delivery failed:", emailError);
      emailResult = {
        emailSent: false,
        configured: hasSmtpConfig(getSmtpConfig()),
      };
    }

    return res.status(sheetResult.synced && emailResult.emailSent ? 200 : 202).json({
      ok: true,
      emailSent: emailResult.emailSent,
      googleSheetSynced: sheetResult.synced,
      message: buildSubmissionMessage(sheetResult, emailResult),
    });
  } catch (error) {
    console.error("Lead submission failed:", error);
    return res.status(500).json({
      ok: false,
      message: "Something went wrong while saving this lead.",
    });
  }
});

app.use("/api", (_req, res) => {
  res.status(404).json({
    ok: false,
    message: "API route not found.",
  });
});

app.get("/*splat", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Afriwork hiring guide running at http://localhost:${PORT}`);
  });
}

module.exports = app;

function normalizeLead(body = {}) {
  return {
    fullName: normalizeText(body.fullName),
    companyName: normalizeText(body.companyName),
    email: normalizeText(body.email).toLowerCase(),
    phone: normalizePhone(body.phone),
    companyScale: normalizeText(body.companyScale),
    position: normalizeText(body.position),
  };
}

function normalizeText(value) {
  return String(value || "").trim();
}

function getBooleanEnv(name, defaultValue = false) {
  const value = normalizeText(process.env[name]).toLowerCase();

  if (!value) {
    return defaultValue;
  }

  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function normalizeGuideDownloadUrl(value) {
  const url = normalizeText(value);

  if (!url) {
    return "";
  }

  const driveFileMatch = url.match(/drive\.google\.com\/file\/d\/([^/]+)/i);
  if (driveFileMatch?.[1]) {
    return `https://drive.google.com/uc?export=download&id=${driveFileMatch[1]}`;
  }

  return url;
}

function normalizePhone(value) {
  const digits = normalizeText(value).replace(/\D/g, "");

  if (!digits) {
    return "";
  }

  if (digits.startsWith("251") && digits.length === 12) {
    return `+${digits}`;
  }

  if (digits.startsWith("0") && digits.length === 10) {
    return `+251${digits.slice(1)}`;
  }

  if (digits.length === 9) {
    return `+251${digits}`;
  }

  return `+${digits}`;
}

function validateLead(lead) {
  const requiredFields = [
    ["fullName", "Please enter the full name."],
    ["companyName", "Please enter the company name."],
    ["email", "Please enter the email address."],
    ["phone", "Please enter the phone number."],
    ["companyScale", "Please choose the company size."],
    ["position", "Please enter the job title or position."],
  ];

  for (const [key, message] of requiredFields) {
    if (!lead[key]) {
      return message;
    }
  }

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(lead.email)) {
    return "Please enter a valid email address.";
  }

  const phonePattern = /^\+251\d{9}$/;
  if (!phonePattern.test(lead.phone)) {
    return "Please enter 9 digits after +251.";
  }

  return null;
}

async function appendLeadToCsv(record) {
  await fsp.mkdir(STORAGE_DIR, { recursive: true });

  const csvHeader = `${fieldOrder.join(",")}\n`;
  const csvRow = `${fieldOrder.map((field) => csvEscape(record[field])).join(",")}\n`;
  const fileExists = fs.existsSync(LEADS_CSV_PATH);
  const payload = fileExists ? csvRow : `${csvHeader}${csvRow}`;

  await fsp.appendFile(LEADS_CSV_PATH, payload, "utf8");
}

function csvEscape(value) {
  const escaped = String(value ?? "").replace(/"/g, '""');
  return `"${escaped}"`;
}

function getSmtpConfig() {
  const port = Number(process.env.SMTP_PORT || 587);
  const secure =
    process.env.SMTP_SECURE === "true" || (Number.isFinite(port) && port === 465);

  return {
    host: process.env.SMTP_HOST,
    port,
    secure,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    adminEmail: process.env.ADMIN_EMAIL,
  };
}

function hasSmtpConfig(config) {
  return Boolean(config.host && config.port && config.user && config.pass && config.from);
}

function getGoogleSheetsConfig() {
  return {
    spreadsheetId: normalizeText(process.env.GOOGLE_SHEETS_SPREADSHEET_ID),
    sheetName: normalizeText(process.env.GOOGLE_SHEETS_SHEET_NAME),
    serviceAccountEmail: normalizeText(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL),
    privateKey: normalizeText(process.env.GOOGLE_PRIVATE_KEY).replace(/\\n/g, "\n"),
    keyFile: normalizeText(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE),
    credentialsJson: normalizeText(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
  };
}

function hasGoogleSheetsConfig(config) {
  if (!config.spreadsheetId) {
    return false;
  }

  return Boolean(
    config.keyFile ||
      config.credentialsJson ||
      (config.serviceAccountEmail && config.privateKey)
  );
}

async function getTransporter() {
  if (cachedTransporter) {
    return cachedTransporter;
  }

  const config = getSmtpConfig();
  if (!hasSmtpConfig(config)) {
    return null;
  }

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.pass,
    },
  });

  await transporter.verify();
  cachedTransporter = transporter;
  return transporter;
}

async function sendLeadMagnet(lead, pdfBuffer, downloadUrl) {
  const config = getSmtpConfig();
  if (!hasSmtpConfig(config)) {
    return {
      emailSent: false,
      configured: false,
    };
  }

  const transporter = await getTransporter();

  await transporter.sendMail({
    from: config.from,
    to: lead.email,
    subject: "Your Afriwork hiring guide is here",
    html: buildLeadEmailHtml(lead, downloadUrl),
    text: buildLeadEmailText(lead, downloadUrl),
    attachments: [
      {
        filename: "afriwork-hiring-guide.pdf",
        content: pdfBuffer,
        contentType: "application/pdf",
      },
      {
        filename: "afriwork-logo.svg",
        path: EMAIL_LOGO_PATH,
        cid: "afriwork-logo",
        contentType: "image/svg+xml",
      },
    ],
  });

  if (config.adminEmail) {
    await transporter.sendMail({
      from: config.from,
      to: config.adminEmail,
      subject: `New lead: ${lead.fullName} from ${lead.companyName}`,
      html: buildAdminEmailHtml(lead),
      text: buildAdminEmailText(lead),
    });
  }

  return {
    emailSent: true,
    configured: true,
  };
}

async function syncLeadToGoogleSheets(record) {
  const config = getGoogleSheetsConfig();

  if (!hasGoogleSheetsConfig(config)) {
    return {
      synced: false,
      configured: false,
    };
  }

  try {
    const sheets = await getGoogleSheetsClient(config);
    const targetSheetName = await resolveGoogleSheetName(sheets, config);
    await ensureGoogleSheetHeader(sheets, config, targetSheetName);

    await sheets.spreadsheets.values.append({
      spreadsheetId: config.spreadsheetId,
      range: `${targetSheetName}!A:G`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          [
            record.submittedAt,
            record.fullName,
            record.companyName,
            record.email,
            record.phone,
            record.companyScale,
            record.position,
          ],
        ],
      },
    });

    return {
      synced: true,
      configured: true,
    };
  } catch (error) {
    console.error("Google Sheets sync failed:", error);
    return {
      synced: false,
      configured: true,
    };
  }
}

async function getGoogleSheetsClient(config) {
  if (cachedSheetsClient) {
    return cachedSheetsClient;
  }

  const credentials = await loadGoogleCredentials(config);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  cachedSheetsClient = google.sheets({
    version: "v4",
    auth,
  });

  return cachedSheetsClient;
}

async function loadGoogleCredentials(config) {
  if (config.credentialsJson) {
    return JSON.parse(config.credentialsJson);
  }

  if (config.keyFile) {
    const keyFilePath = path.resolve(__dirname, config.keyFile);
    const keyFileContents = await fsp.readFile(keyFilePath, "utf8");
    return JSON.parse(keyFileContents);
  }

  return {
    client_email: config.serviceAccountEmail,
    private_key: config.privateKey,
  };
}

async function resolveGoogleSheetName(sheets, config) {
  if (config.sheetName) {
    return config.sheetName;
  }

  const response = await sheets.spreadsheets.get({
    spreadsheetId: config.spreadsheetId,
    fields: "sheets(properties(title))",
  });

  const firstSheetTitle = response.data.sheets?.[0]?.properties?.title;

  if (!firstSheetTitle) {
    throw new Error("Could not determine the target Google Sheets tab.");
  }

  return firstSheetTitle;
}

async function ensureGoogleSheetHeader(sheets, config, sheetName) {
  const headerRange = `${sheetName}!A1:G1`;

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: headerRange,
  });

  if (response.data.values?.[0]?.length) {
    return;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: config.spreadsheetId,
    range: headerRange,
    valueInputOption: "RAW",
    requestBody: {
      values: [
        [
          "Submitted At",
          "Full Name",
          "Company Name",
          "Email",
          "Phone",
          "Company Size",
          "Position",
        ],
      ],
    },
  });
}

function buildSubmissionMessage(sheetResult, emailResult) {
  if (sheetResult.synced && emailResult.emailSent) {
    return "The PDF has been sent and the lead was saved to Google Sheets.";
  }

  if (sheetResult.synced && !emailResult.configured) {
    return "Lead saved to Google Sheets. Configure SMTP in .env to automatically email the PDF.";
  }

  if (sheetResult.synced && !emailResult.emailSent) {
    return "Lead saved to Google Sheets, but the PDF email could not be sent. Check your SMTP settings.";
  }

  if (!sheetResult.configured && emailResult.emailSent) {
    return "The PDF has been sent. Configure Google Sheets in .env to sync submissions there too.";
  }

  if (sheetResult.configured && !sheetResult.synced && emailResult.emailSent) {
    return ENABLE_LOCAL_FILE_STORAGE
      ? "The PDF has been sent, but Google Sheets sync failed. The lead was still saved locally."
      : "The PDF has been sent, but Google Sheets sync failed.";
  }

  if (!sheetResult.configured && !emailResult.configured) {
    return ENABLE_LOCAL_FILE_STORAGE
      ? "Lead saved locally. Configure SMTP and Google Sheets in .env to email the PDF and sync submissions."
      : "Submission received, but SMTP and Google Sheets are not configured yet.";
  }

  if (!sheetResult.configured) {
    return ENABLE_LOCAL_FILE_STORAGE
      ? "Lead saved locally. Configure Google Sheets in .env to sync submissions there."
      : "Submission received. Configure Google Sheets in .env to sync submissions there.";
  }

  if (!emailResult.configured) {
    return ENABLE_LOCAL_FILE_STORAGE
      ? "Lead saved locally. Configure SMTP in .env to automatically email the PDF."
      : "Submission received. Configure SMTP in .env to automatically email the PDF.";
  }

  return ENABLE_LOCAL_FILE_STORAGE
    ? "Lead saved locally, but email delivery and Google Sheets sync need attention. Check your .env settings."
    : "Submission received, but email delivery and Google Sheets sync need attention. Check your .env settings.";
}

function buildLeadEmailHtml(lead, downloadUrl) {
  const downloadHtml = downloadUrl
    ? `
        <p style="margin:0 0 18px; font-size:16px; line-height:1.7;">
          Prefer opening it in your browser?
          <a href="${escapeHtml(downloadUrl)}" style="color:#7a2a7d; text-decoration:underline;">Download the guide here</a>.
        </p>
        <div style="margin:0 0 24px;">
          <a href="${escapeHtml(downloadUrl)}" style="display:inline-block; padding:14px 22px; background:#f7f2ed; color:#2b1933; border:1px solid #ecdccc; border-radius:999px; text-decoration:none; font-weight:700;">
            Download PDF
          </a>
        </div>
      `
    : "";

  return `
    <div style="font-family: Arial, Helvetica, sans-serif; background:#fffaf5; color:#2b1933; padding:32px;">
      <div style="max-width:600px; margin:0 auto; background:#ffffff; border-radius:20px; padding:32px; border:1px solid #f0ddca;">
        <img src="cid:afriwork-logo" alt="Afriwork" width="85" height="16" style="display:block; margin:0 0 16px; width:85px; height:16px;" />
        <h1 style="margin:0 0 16px; font-size:32px; line-height:1.2;">Your hiring guide is attached</h1>
        <p style="margin:0 0 14px; font-size:16px; line-height:1.7;">Hi ${escapeHtml(lead.fullName)},</p>
        <p style="margin:0 0 14px; font-size:16px; line-height:1.7;">
          Thanks for requesting the Afriwork hiring guide. We've attached the PDF so you can
          review the main reasons small businesses get stuck even after receiving lots of applications.
        </p>
        <p style="margin:0 0 24px; font-size:16px; line-height:1.7;">
          If you'd like help building a better shortlist or reducing time-to-hire at ${escapeHtml(
            lead.companyName
          )}, reply to this email and the Afriwork team can help.
        </p>
        ${downloadHtml}
        <a href="mailto:nahusenaygebreamlak@gmail.com" style="display:inline-block; padding:14px 22px; background:#7a2a7d; color:#ffffff; border-radius:999px; text-decoration:none; font-weight:700;">
          Talk to Afriwork
        </a>
      </div>
    </div>
  `;
}

function buildLeadEmailText(lead, downloadUrl) {
  const lines = [
    `Hi ${lead.fullName},`,
    "",
    "Thanks for requesting the Afriwork hiring guide.",
    "The PDF is attached to this email.",
    "",
    `If you want help improving hiring at ${lead.companyName}, reply to this message and the Afriwork team can help.`,
  ];

  if (downloadUrl) {
    lines.push("");
    lines.push(`Download link: ${downloadUrl}`);
  }

  return lines.join("\n");
}

function buildAdminEmailHtml(lead) {
  return `
    <div style="font-family: Arial, Helvetica, sans-serif; color:#1b1320;">
      <h2>New lead captured</h2>
      <p><strong>Name:</strong> ${escapeHtml(lead.fullName)}</p>
      <p><strong>Company:</strong> ${escapeHtml(lead.companyName)}</p>
      <p><strong>Email:</strong> ${escapeHtml(lead.email)}</p>
      <p><strong>Phone:</strong> ${escapeHtml(lead.phone)}</p>
      <p><strong>Company scale:</strong> ${escapeHtml(lead.companyScale)}</p>
      <p><strong>Position:</strong> ${escapeHtml(lead.position)}</p>
    </div>
  `;
}

function buildAdminEmailText(lead) {
  return [
    "New lead captured",
    `Name: ${lead.fullName}`,
    `Company: ${lead.companyName}`,
    `Email: ${lead.email}`,
    `Phone: ${lead.phone}`,
    `Company scale: ${lead.companyScale}`,
    `Position: ${lead.position}`,
  ].join("\n");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function createDownloadLink(req, pdfBuffer) {
  await fsp.mkdir(DOWNLOADS_DIR, { recursive: true });

  const token = randomUUID();
  const filePath = path.join(DOWNLOADS_DIR, `${token}.pdf`);
  await fsp.writeFile(filePath, pdfBuffer);

  return `${getBaseUrl(req)}/download/${token}`;
}

function getBaseUrl(req) {
  const forwardedProto = normalizeText(req.headers["x-forwarded-proto"]);
  const protocol = forwardedProto || req.protocol || "http";
  return `${protocol}://${req.get("host")}`;
}

function sanitizeDownloadToken(value) {
  const token = normalizeText(value);
  return /^[a-f0-9-]{36}$/i.test(token) ? token : null;
}

function generateLeadMagnetPdf(lead) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 56,
      info: {
        Title: "Afriwork Hiring Guide",
        Author: "Afriwork",
      },
    });

    const chunks = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    drawPdfCover(doc, lead);
    doc.addPage();
    drawPdfChecklist(doc);

    doc.end();
  });
}

function drawPdfCover(doc, lead) {
  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;

  doc.rect(0, 0, pageWidth, pageHeight).fill("#fffaf5");

  doc.save();
  doc.circle(pageWidth - 110, pageHeight - 20, 160).fill("#f4e7d8");
  doc.circle(80, pageHeight - 80, 130).fill("#f7ece1");
  doc.restore();

  doc.fillColor("#7a2a7d").fontSize(15).text("AFRIWORK", 56, 58);
  doc
    .fontSize(27)
    .fillColor("#2d1834")
    .text("Why Small Businesses", 56, 120)
    .text("Struggle to Hire Even After", 56, 156);

  const markX = 56;
  const markY = 206;
  const markWidth = 320;
  const markHeight = 68;
  doc.roundedRect(markX, markY, markWidth, markHeight, 4).fill("#f0a545");
  doc
    .fillColor("#ffffff")
    .fontSize(27)
    .text("Receiving Hundreds of", markX + 12, markY + 10)
    .text("Applications.", markX + 12, markY + 40);

  doc
    .fillColor("#4f3b5a")
    .fontSize(12)
    .text(
      "A practical brief from Afriwork on the hidden bottlenecks that slow down shortlisting, screening, and hiring decisions.",
      56,
      320,
      { width: 470, lineGap: 4 }
    );

  doc.roundedRect(56, 392, 240, 124, 18).fillAndStroke("#ffffff", "#ead8c7");
  doc
    .fillColor("#7a2a7d")
    .fontSize(12)
    .text("Prepared for", 80, 420)
    .fillColor("#1f1425")
    .fontSize(21)
    .text(lead.fullName, 80, 442, { width: 190 })
    .fontSize(12)
    .fillColor("#6d5a73")
    .text(lead.companyName, 80, 476, { width: 190 });

  doc.fillColor("#2d1834").fontSize(15).text("Inside this guide", 330, 404);
  addPdfBullet(doc, 330, 436, "Why high application volume still creates hiring delays");
  addPdfBullet(doc, 330, 472, "Common shortlist and screening mistakes");
  addPdfBullet(doc, 330, 508, "Simple ways to speed up time-to-hire");
}

function drawPdfChecklist(doc) {
  doc.rect(0, 0, doc.page.width, doc.page.height).fill("#ffffff");
  doc.fillColor("#7a2a7d").fontSize(14).text("AFRIWORK HIRING CHECKLIST", 56, 62);
  doc
    .fillColor("#221529")
    .fontSize(28)
    .text("Three reasons strong applicants still do not become hires", 56, 102, {
      width: 470,
      lineGap: 4,
    });

  const sections = [
    {
      title: "1. Too many unqualified applications crowd the shortlist",
      body:
        "Application volume looks healthy, but it often hides weak fit. Teams lose time reviewing profiles that never had the right experience, availability, or salary alignment.",
    },
    {
      title: "2. Hiring steps are unclear or too slow",
      body:
        "Candidates drop out when there are delays between review, first contact, interviews, and feedback. Small process gaps compound quickly and stretch the time-to-hire.",
    },
    {
      title: "3. Teams rely on volume instead of role-fit signals",
      body:
        "The best candidates are easier to identify when requirements, scorecards, and follow-up steps are consistent. Without that structure, strong people get missed.",
    },
  ];

  let cursorY = 190;

  for (const section of sections) {
    doc.roundedRect(56, cursorY, 485, 116, 16).fillAndStroke("#fff9f3", "#f0ddca");
    doc
      .fillColor("#2d1834")
      .fontSize(16)
      .text(section.title, 76, cursorY + 20, { width: 445, lineGap: 3 });
    doc
      .fillColor("#65546b")
      .fontSize(12)
      .text(section.body, 76, cursorY + 56, { width: 430, lineGap: 4 });
    cursorY += 138;
  }

  doc.fillColor("#7a2a7d").fontSize(16).text("What to do next", 56, 634);
  addPdfBullet(doc, 56, 664, "Tighten your must-have criteria before opening the role.");
  addPdfBullet(doc, 56, 698, "Screen against a short scorecard instead of general impressions.");
  addPdfBullet(doc, 56, 732, "Respond faster to qualified talent so momentum is not lost.");
}

function addPdfBullet(doc, x, y, text) {
  doc.circle(x + 6, y + 7, 3).fill("#f0a545");
  doc
    .fillColor("#493950")
    .fontSize(12)
    .text(text, x + 18, y, { width: 380, lineGap: 3 });
}
