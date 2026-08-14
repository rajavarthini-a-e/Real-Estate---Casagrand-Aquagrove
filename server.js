import express from 'express';
import sqlite3 from 'sqlite3';
import dotenv from 'dotenv';
import nodePath from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { google } from 'googleapis';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());

// Resolve __dirname in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = nodePath.dirname(__filename);

// --- SQLite Database Setup ---
const dbPath = nodePath.join(__dirname, 'homematch.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('[DB] Connection error:', err.message);
  } else {
    console.log(`[DB] Connected to SQLite database at: ${dbPath}`);
  }
});

// Promise wrappers for SQLite
const dbRun = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
};

const dbAll = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const dbGet = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

// Initialize database schema (LEADS, CALL_LOGS, and MEETINGS) - NO DROPPING OR RE-CREATION ON RESTART
async function initDb() {
  // Create LEADS Table
  await dbRun(`
    CREATE TABLE IF NOT EXISTS LEADS (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT NOT NULL,
      location TEXT NOT NULL,
      requirement TEXT NOT NULL,
      lead_status TEXT DEFAULT 'NEW',
      call_status TEXT DEFAULT 'PENDING',
      meeting_status TEXT DEFAULT 'NOT_BOOKED',
      interested INTEGER DEFAULT 0,
      snapserve_lead_agent_id TEXT,
      snapserve_meeting_agent_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Create CALL_LOGS Table
  await dbRun(`
    CREATE TABLE IF NOT EXISTS CALL_LOGS (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      snapserve_call_id TEXT UNIQUE,
      agent_id TEXT,
      agent_name TEXT,
      status TEXT,
      duration TEXT,
      started_at TEXT,
      ended_at TEXT,
      summary TEXT,
      transcript TEXT,
      recording_url TEXT,
      raw_snapserve_data TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(lead_id) REFERENCES LEADS(id)
    )
  `);

  // Create MEETINGS Table
  await dbRun(`
    CREATE TABLE IF NOT EXISTS MEETINGS (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      snapserve_call_id TEXT,
      status TEXT,
      meeting_time TEXT,
      meeting_link TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(lead_id) REFERENCES LEADS(id)
    )
  `);

  // Self-healing database migration for any missing columns
  const migrateColumn = async (table, column, typeDef) => {
    try {
      const info = await dbAll(`PRAGMA table_info(${table})`);
      const exists = info.some(col => col.name === column);
      if (!exists) {
        console.log(`[DB MIGRATION] Adding column ${column} to table ${table}...`);
        await dbRun(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeDef}`);
      }
    } catch (e) {
      console.error(`[DB MIGRATION ERROR] Failed to check/migrate column ${column} in table ${table}:`, e.message);
    }
  };

  // Migrate LEADS columns
  await migrateColumn('LEADS', 'lead_status', "TEXT DEFAULT 'NEW'");
  await migrateColumn('LEADS', 'call_status', "TEXT DEFAULT 'PENDING'");
  await migrateColumn('LEADS', 'meeting_status', "TEXT DEFAULT 'NOT_BOOKED'");
  await migrateColumn('LEADS', 'interested', "INTEGER DEFAULT 0");
  await migrateColumn('LEADS', 'snapserve_lead_agent_id', "TEXT");
  await migrateColumn('LEADS', 'snapserve_meeting_agent_id', "TEXT");
  await migrateColumn('LEADS', 'samuel_call_id', "TEXT");
  await migrateColumn('LEADS', 'customer_feedback', "TEXT");
  await migrateColumn('LEADS', 'preferred_bhk', "TEXT");
  await migrateColumn('LEADS', 'preferred_property_type', "TEXT");
  await migrateColumn('LEADS', 'presentation_completed', "INTEGER DEFAULT 0");
  await migrateColumn('LEADS', 'feedback_collected', "INTEGER DEFAULT 0");

  // Migrate CALL_LOGS columns
  await migrateColumn('CALL_LOGS', 'agent_name', "TEXT");
  await migrateColumn('CALL_LOGS', 'raw_snapserve_data', "TEXT");

  // Migrate MEETINGS columns
  await migrateColumn('MEETINGS', 'booking_id', "INTEGER");
  await migrateColumn('MEETINGS', 'email_status', "TEXT");
  await migrateColumn('MEETINGS', 'calendar_sync_status', "TEXT");
  
  console.log('[DB] LEADS, CALL_LOGS, and MEETINGS schemas verified and migrated.');
}

// --- SnapServe Config ---
const SNAPSERVE_API_KEY = process.env.SNAPSERVE_API_KEY;
const SNAPSERVE_BASE_URL = process.env.SNAPSERVE_BASE_URL || 'https://app.snapserve.ai/api';
const SNAPSERVE_MCP_PATH = process.env.SNAPSERVE_MCP_PATH 
  ? (nodePath.isAbsolute(process.env.SNAPSERVE_MCP_PATH)
      ? process.env.SNAPSERVE_MCP_PATH
      : nodePath.resolve(__dirname, process.env.SNAPSERVE_MCP_PATH))
  : nodePath.join(__dirname, 'snapserve-mcp/dist/index.js');
const SNAPSERVE_LEAD_AGENT_ID = process.env.SNAPSERVE_LEAD_AGENT_ID || '596'; // Robert - Lead Qualifier
const SNAPSERVE_MEETING_AGENT_ID = process.env.SNAPSERVE_MEETING_AGENT_ID || '597'; // Samuel - Meeting Scheduler

// Format phone number to E.164
const formatToE164 = (phone) => {
  let cleaned = String(phone).replace(/[^0-9+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.length === 10) return `+91${cleaned}`;
  if (cleaned.length === 12 && cleaned.startsWith('91')) return `+${cleaned}`;
  return `+91${cleaned}`;
};

// Helper to normalize lead statuses for dashboard compatibility
function normalizeLead(lead) {
  if (!lead) return lead;
  
  let meetingStatus = lead.meeting_status;
  if (meetingStatus) {
    const upper = meetingStatus.toUpperCase();
    if (upper === 'BOOKED') meetingStatus = 'Booked';
    else if (upper === 'NOT_BOOKED' || upper === 'NOT BOOKED') meetingStatus = 'Not Booked';
    else if (upper === 'PENDING') meetingStatus = 'Pending';
    else if (upper === 'FAILED') meetingStatus = 'Failed';
    else if (upper === 'TRIGGERED') meetingStatus = 'Triggered';
  }

  let leadStatus = lead.lead_status;
  if (leadStatus) {
    const upper = leadStatus.toUpperCase();
    if (upper === 'INTERESTED') leadStatus = 'Interested';
    else if (upper === 'NOT_INTERESTED' || upper === 'NOT INTERESTED') leadStatus = 'Not Interested';
    else if (upper === 'NEW') leadStatus = 'New';
    else if (upper === 'FOLLOW_UP' || upper === 'FOLLOW-UP') leadStatus = 'Follow-up';
  }

  return {
    ...lead,
    meeting_status: meetingStatus,
    lead_status: leadStatus
  };
}

// --- Agent ID Verification (Robert Validation) ---
async function verifyAgentIsRobert() {
  if (!SNAPSERVE_API_KEY) {
    throw new Error('SNAPSERVE_API_KEY is not configured in .env');
  }
  if (!SNAPSERVE_LEAD_AGENT_ID) {
    throw new Error('SNAPSERVE_LEAD_AGENT_ID is not configured in .env');
  }
  if (!SNAPSERVE_MCP_PATH || !fs.existsSync(SNAPSERVE_MCP_PATH)) {
    throw new Error(`SnapServe MCP Server not found at path: ${SNAPSERVE_MCP_PATH}`);
  }

  const transport = new StdioClientTransport({
    command: 'node',
    args: [SNAPSERVE_MCP_PATH],
    env: {
      SNAPSERVE_API_KEY,
      SNAPSERVE_BASE_URL,
      PATH: process.env.PATH
    }
  });

  const client = new Client(
    { name: 'homematch-verifier-client', version: '1.0.0' },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: 'snapserve_list_agents',
      arguments: {}
    });

    let data;
    if (result && result.content && Array.isArray(result.content)) {
      const textObj = result.content.find(c => c.type === 'text');
      if (textObj && textObj.text) {
        data = JSON.parse(textObj.text);
      }
    }
    await client.close();

    const agents = data || [];
    const matchedAgent = agents.find(a => String(a.id) === String(SNAPSERVE_LEAD_AGENT_ID));

    if (!matchedAgent) {
      throw new Error(`Agent ID ${SNAPSERVE_LEAD_AGENT_ID} was not found on SnapServe.`);
    }

    if (!matchedAgent.name || !matchedAgent.name.toLowerCase().includes('robert')) {
      throw new Error(`Configured Agent ID ${SNAPSERVE_LEAD_AGENT_ID} corresponds to "${matchedAgent.name}", not Robert.`);
    }

    return matchedAgent;
  } catch (err) {
    try {
      await client.close();
    } catch {}
    throw err;
  }
}

// MCP connection checking logs on startup
async function verifyMcpConnection() {
  console.log('[MCP] Connecting...');
  try {
    await verifyAgentIsRobert();
    console.log('[MCP] Connected successfully');
  } catch (err) {
    console.error('[MCP ERROR] Connection check failed:', err.message);
  }
}

verifyMcpConnection().catch(console.error);

// --- Prompt Resolution Helpers ---
function resolveRobertPrompt(lead) {
  try {
    const template = fs.readFileSync(nodePath.join(__dirname, 'robert_base_prompt.txt'), 'utf8');
    return template
      .replace(/{{metadata\.name}}/g, lead.name || 'N/A')
      .replace(/{{metadata\.email}}/g, lead.email || 'N/A')
      .replace(/{{metadata\.phone}}/g, lead.phone || 'N/A')
      .replace(/{{metadata\.location}}/g, lead.location || 'N/A')
      .replace(/{{metadata\.requirement}}/g, lead.requirement || 'N/A')
      .replace(/{{metadata\.leadId}}/g, lead.id || 'N/A')
      .replace(/{{name}}/g, lead.name || 'N/A')
      .replace(/{{email}}/g, lead.email || 'N/A')
      .replace(/{{phone}}/g, lead.phone || 'N/A')
      .replace(/{{location}}/g, lead.location || 'N/A')
      .replace(/{{requirement}}/g, lead.requirement || 'N/A')
      .replace(/{{leadId}}/g, lead.id || 'N/A')
      .replace(/{name}/g, lead.name || 'N/A')
      .replace(/{email}/g, lead.email || 'N/A')
      .replace(/{phone}/g, lead.phone || 'N/A')
      .replace(/{location}/g, lead.location || 'N/A')
      .replace(/{requirement}/g, lead.requirement || 'N/A')
      .replace(/{leadId}/g, lead.id || 'N/A');
  } catch (err) {
    console.error('[PROMPT RESOLVE ERROR] Failed to load Robert prompt template:', err.message);
    return null;
  }
}

function resolveSamuelPrompt(lead) {
  try {
    const template = fs.readFileSync(nodePath.join(__dirname, 'samuel_base_prompt.txt'), 'utf8');
    
    // Extract budget and BHK from requirement if not directly available
    let budgetVal = lead.budget;
    if (!budgetVal && lead.requirement) {
      const parts = lead.requirement.split(',');
      if (parts.length > 1) {
        budgetVal = parts[0].split('—').pop().trim();
      }
    }
    budgetVal = budgetVal || 'Below ₹50 Lakhs';

    let bhkVal = lead.bedrooms;
    if (!bhkVal && lead.requirement) {
      const match = lead.requirement.match(/(\d+\s*BHK)/i);
      if (match) {
        bhkVal = match[1];
      }
    }
    bhkVal = bhkVal || '2 BHK';
    
    return template
      .replace(/{{metadata\.name}}/g, lead.name || 'N/A')
      .replace(/{{metadata\.email}}/g, lead.email || 'N/A')
      .replace(/{{metadata\.phone}}/g, lead.phone || 'N/A')
      .replace(/{{metadata\.location}}/g, lead.location || 'N/A')
      .replace(/{{metadata\.requirement}}/g, lead.requirement || 'N/A')
      .replace(/{{metadata\.leadId}}/g, lead.id || 'N/A')
      .replace(/{{name}}/g, lead.name || 'N/A')
      .replace(/{{email}}/g, lead.email || 'N/A')
      .replace(/{{phone}}/g, lead.phone || 'N/A')
      .replace(/{{location}}/g, lead.location || 'N/A')
      .replace(/{{requirement}}/g, lead.requirement || 'N/A')
      .replace(/{{leadId}}/g, lead.id || 'N/A')
      .replace(/{name}/g, lead.name || 'N/A')
      .replace(/{email}/g, lead.email || 'N/A')
      .replace(/{phone}/g, lead.phone || 'N/A')
      .replace(/{location}/g, lead.location || 'N/A')
      .replace(/{requirement}/g, lead.requirement || 'N/A')
      .replace(/{leadId}/g, lead.id || 'N/A')
      .replace(/{{budget}}/g, budgetVal)
      .replace(/{{BHK}}/g, bhkVal)
      .replace(/{{purchasePurpose}}/g, lead.lookingFor || 'Own Use')
      .replace(/{{purchaseTimeline}}/g, 'Immediate')
      .replace(/{{conversationSummary}}/g, lead.robertSummary || 'Qualified by Robert')
      .replace(/{{customerQuestions}}/g, 'Wants to see the project highlights')
      .replace(/{budget}/g, budgetVal)
      .replace(/{BHK}/g, bhkVal)
      .replace(/{purchase\s*purpose}/gi, lead.lookingFor || 'Own Use')
      .replace(/{purchase\s*timeline}/gi, 'Immediate')
      .replace(/{conversation\s*summary}/gi, lead.robertSummary || 'Qualified by Robert')
      .replace(/{customer\s*questions}/gi, 'Wants to see the project highlights');
  } catch (err) {
    console.error('[PROMPT RESOLVE ERROR] Failed to load Samuel prompt template:', err.message);
    return null;
  }
}

async function updateAgentPrompt(agentId, prompt) {
  const url = `${SNAPSERVE_BASE_URL}/agents/${agentId}`;
  console.log(`[API PATCH] Updating agent ${agentId} systemPrompt...`);
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SNAPSERVE_API_KEY}`
    },
    body: JSON.stringify({ systemPrompt: prompt })
  });

  if (!response.ok) {
    throw new Error(`Failed to update agent prompt: ${response.status} ${response.statusText}`);
  }
  console.log(`[API PATCH] Agent ${agentId} prompt updated successfully.`);
}

// --- MCP Call Trigger ---
async function triggerSnapServeCall(phone, lead, agentId = SNAPSERVE_LEAD_AGENT_ID) {
  if (String(agentId) === String(SNAPSERVE_LEAD_AGENT_ID)) {
    await verifyAgentIsRobert();
  }

  const formattedPhone = formatToE164(phone);

  const transport = new StdioClientTransport({
    command: 'node',
    args: [SNAPSERVE_MCP_PATH],
    env: {
      SNAPSERVE_API_KEY,
      SNAPSERVE_BASE_URL,
      PATH: process.env.PATH
    }
  });

  const client = new Client(
    { name: 'homematch-backend-client', version: '1.0.0' },
    { capabilities: {} }
  );

  try {
    // PATCH the system prompt to the agent configuration before triggering the call
    try {
      const resolvedPrompt = String(agentId) === String(SNAPSERVE_MEETING_AGENT_ID) ? resolveSamuelPrompt(lead) : resolveRobertPrompt(lead);
      if (resolvedPrompt) {
        await updateAgentPrompt(agentId, resolvedPrompt);
      }
    } catch (patchErr) {
      console.error(`[PROMPT PATCH FAILED] Failed to update prompt for agent ${agentId}:`, patchErr.message);
    }

    await client.connect(transport);
    
    // Construct lead metadata payload
    const isSamuel = String(agentId) === String(SNAPSERVE_MEETING_AGENT_ID);
    const metadata = isSamuel ? {
      leadId: lead.id,
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      location: lead.location,
      requirement: lead.requirement,
      budget: lead.budget || lead.requirement?.split(',')[1]?.trim() || 'Below ₹50 Lakhs',
      preferredBHK: lead.bedrooms || lead.requirement?.split(' — ')[1]?.split(' ')[0] + ' BHK' || '2 BHK',
      purchasePurpose: lead.lookingFor || 'Own Use',
      purchaseTimeline: 'Immediate',
      conversationSummary: lead.robertSummary || 'Qualified by Robert',
      customerQuestions: 'Wants to see the project highlights'
    } : {
      name: lead.name,
      studentName: lead.name,
      phone: lead.phone,
      email: lead.email,
      location: lead.location,
      lookingFor: lead.lookingFor,
      propertyType: lead.propertyType,
      bedrooms: lead.bedrooms,
      budget: lead.budget,
      preferredCallbackTime: lead.preferredCallbackTime,
      leadId: lead.id
    };

    const payload = {
      phone: formattedPhone,
      agentId: Number(agentId),
      metadata
    };

    const result = await client.callTool({
      name: 'snapserve_start_outbound_call',
      arguments: payload
    });

    let data;
    if (result && result.content && Array.isArray(result.content)) {
      const textObj = result.content.find(c => c.type === 'text');
      if (textObj && textObj.text) {
        try {
          data = JSON.parse(textObj.text);
        } catch {
          data = textObj.text;
        }
      }
    }
    
    await client.close();
    return data;
  } catch (err) {
    try {
      await client.close();
    } catch {}
    throw err;
  }
}

// --- Fetch Calls List via MCP ---
async function fetchSnapServeCalls() {
  if (!SNAPSERVE_API_KEY || !SNAPSERVE_MCP_PATH || !fs.existsSync(SNAPSERVE_MCP_PATH)) {
    return [];
  }

  const transport = new StdioClientTransport({
    command: 'node',
    args: [SNAPSERVE_MCP_PATH],
    env: {
      SNAPSERVE_API_KEY,
      SNAPSERVE_BASE_URL,
      PATH: process.env.PATH
    }
  });

  const client = new Client(
    { name: 'homematch-backend-client', version: '1.0.0' },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
    
    console.log('[MCP] Fetching SnapServe calls...');
    console.log('[MCP] Tool: snapserve_list_calls');
    
    const result = await client.callTool({
      name: 'snapserve_list_calls',
      arguments: { limit: 100 }
    });

    let data;
    if (result && result.content && Array.isArray(result.content)) {
      const textObj = result.content.find(c => c.type === 'text');
      if (textObj && textObj.text) {
        try {
          data = JSON.parse(textObj.text);
        } catch {
          data = textObj.text;
        }
      }
    }

    console.log('[MCP] Raw response:');
    console.log(JSON.stringify(data, null, 2));

    await client.close();
    return data?.calls || data || [];
  } catch (err) {
    console.error('[MCP ERROR] Failed to fetch calls:', err.message);
    try {
      await client.close();
    } catch {}
    throw err;
  }
}

// --- Google Sheets Sync Utility ---
async function syncToGoogleSheets(lead, meeting, interestStatus) {
  // Extract values
  const requirementVal = lead.requirement || 'N/A';
  let budgetVal = lead.budget;
  if (!budgetVal && lead.requirement) {
    const parts = lead.requirement.split(',');
    if (parts.length > 1) {
      budgetVal = parts[0].split('—').pop().trim();
    }
  }
  budgetVal = budgetVal || 'Below ₹50 Lakhs';

  let bhkVal = lead.bedrooms;
  if (!bhkVal && lead.requirement) {
    const match = lead.requirement.match(/(\d+\s*BHK)/i);
    if (match) {
      bhkVal = match[1];
    }
  }
  bhkVal = bhkVal || '2 BHK';

  const presentedProperty = `Casagrand Aquagrove - ${bhkVal}`;

  const rowValues = [
    lead.id || 'N/A',
    lead.name || 'N/A',
    lead.email || 'N/A',
    lead.phone || 'N/A',
    lead.location || 'N/A',
    lead.lookingFor || 'Buy',
    lead.propertyType || 'Apartment',
    requirementVal,
    budgetVal,
    presentedProperty,
    lead.customer_feedback || 'N/A',
    lead.preferred_bhk || 'N/A',
    lead.preferred_property_type || 'N/A',
    interestStatus || (lead.interested ? 'Interested' : 'Not Interested'),
    lead.preferredCallbackTime || 'Evening',
    meeting.status || 'PENDING',
    meeting.meeting_time || 'N/A',
    meeting.meeting_link || 'N/A',
    meeting.snapserve_call_id || 'N/A',
    lead.presentation_completed ? 'Yes' : 'No',
    lead.feedback_collected ? 'Yes' : 'No',
    lead.created_at || new Date().toISOString()
  ];

  const headers = [
    'Lead ID',
    'Customer Name',
    'Customer Email',
    'Customer Phone',
    'Location',
    'Looking For',
    'Property Type',
    'Original BHK / Requirement',
    'Budget',
    'Presented Property',
    'Customer Feedback',
    'Preferred BHK',
    'Preferred Property Type',
    'Interest Status',
    'Preferred Callback Time',
    'Meeting Status',
    'Meeting Date/Time',
    'Google Meet Link',
    'Call ID',
    'Presentation Completed',
    'Feedback Collected',
    'Created At'
  ];

  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let privateKey = process.env.GOOGLE_PRIVATE_KEY;
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const sheetTabName = process.env.GOOGLE_SHEET_TAB_NAME || 'HomeMatch_Leads';

  if (!clientEmail || !privateKey || !spreadsheetId) {
    console.log('[GOOGLE SHEETS] --------------------------------------------------');
    console.log('[GOOGLE SHEETS] Credentials not fully configured in .env (Mock Mode)');
    console.log('[GOOGLE SHEETS] Simulating Sheets row update (Match check by Lead ID or Phone)...');
    console.log(JSON.stringify({
      spreadsheetId: spreadsheetId || 'MOCK_SPREADSHEET_ID',
      tab: sheetTabName,
      row: rowValues
    }, null, 2));
    console.log('[GOOGLE SHEETS] --------------------------------------------------');
    return { success: true, mode: 'mock' };
  }

  try {
    privateKey = privateKey.replace(/\\n/g, '\n');
    const auth = new google.auth.JWT({
      email: clientEmail,
      key: privateKey,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    
    // Check and create headers if sheet is empty
    try {
      const getRes = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetTabName}!A1:V1`,
      });

      if (!getRes.data.values || getRes.data.values.length === 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${sheetTabName}!A1:V1`,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [headers],
          },
        });
      }
    } catch (headerErr) {
      console.warn('[GOOGLE SHEETS] Could not create/verify headers:', headerErr.message);
    }

    // Fetch all existing rows to check for duplicates
    let sheetRows = [];
    try {
      const allRowsRes = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetTabName}!A:V`,
      });
      sheetRows = allRowsRes.data.values || [];
    } catch (e) {
      console.warn('[GOOGLE SHEETS] Could not fetch existing rows for duplicate checking:', e.message);
    }

    // Match by Lead ID (Col A, index 0) or Phone (Col D, index 3)
    let matchedRowIndex = -1;
    const cleanPhone = (p) => String(p).replace(/[^0-9]/g, '');
    const targetLeadId = String(lead.id);
    const targetPhone = cleanPhone(lead.phone);

    for (let i = 1; i < sheetRows.length; i++) {
      const row = sheetRows[i];
      const rowLeadId = String(row[0] || '');
      const rowPhone = cleanPhone(row[3] || '');

      if ((rowLeadId && rowLeadId === targetLeadId) || (rowPhone && targetPhone && rowPhone.endsWith(targetPhone))) {
        matchedRowIndex = i + 1; // 1-indexed row number
        break;
      }
    }

    if (matchedRowIndex !== -1) {
      console.log(`[GOOGLE SHEETS] Matching lead found at row ${matchedRowIndex}. Updating existing row...`);
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetTabName}!A${matchedRowIndex}:V${matchedRowIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [rowValues],
        },
      });
      console.log(`[GOOGLE SHEETS] Successfully updated row ${matchedRowIndex} for lead ${lead.name}.`);
    } else {
      console.log(`[GOOGLE SHEETS] No matching lead found. Appending new row...`);
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetTabName}!A:V`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [rowValues],
        },
      });
      console.log(`[GOOGLE SHEETS] Successfully appended new row for lead ${lead.name}.`);
    }
    return { success: true, mode: 'live' };
  } catch (error) {
    console.error('[GOOGLE SHEETS ERROR] Failed to update Google Sheets:', error.message);
    return { success: false, error: error.message };
  }
}

async function syncSamuelBooking(lead, samuelCallId, _samuelMatch) {
  try {
    if (!lead || !lead.id) {
      console.error(`[SYNC SAMUEL ERROR] Original lead could not be resolved for call ${samuelCallId}. Skipping booking sync.`);
      return;
    }

    console.log(`[SYNC SAMUEL] Fetching logs for call ${samuelCallId}...`);
    const logsUrl = `${SNAPSERVE_BASE_URL}/calls/${samuelCallId}/logs`;
    const response = await fetch(logsUrl, {
      headers: {
        'Authorization': `Bearer ${SNAPSERVE_API_KEY}`
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch logs: ${response.status}`);
    }

    const logs = await response.json();
    console.log(`[SYNC SAMUEL] Fetched ${logs.length} log entries.`);

    let bookingId = null;
    let meetingLink = null;
    let meetingTime = 'Scheduled via Voice Handoff';
    let bookingStatus = 'PENDING';
    let calendarSyncStatus = 'PENDING';
    let emailStatus = 'PENDING';
    let customerFeedback = lead.customer_feedback || null;
    let preferredBHK = lead.preferred_bhk || null;
    let preferredPropertyType = lead.preferred_property_type || null;
    let presentationCompleted = lead.presentation_completed || 0;
    let feedbackCollected = lead.feedback_collected || 0;

    // Parse logs for Booking component steps
    for (const log of logs) {
      if (String(log.component).toLowerCase() === 'booking') {
        const payload = log.responsePayload || {};
        const step = log.requestPayload?.step || '';

        if (step === 'Booking Confirmed') {
          if (payload.bookingId) bookingId = payload.bookingId;
          if (payload.meetLink) meetingLink = payload.meetLink;
          if (payload.slot) meetingTime = payload.slot;
          if (payload.status) bookingStatus = payload.status;
        } else if (step === 'Calendar Event Created') {
          if (payload.calendarSyncStatus) calendarSyncStatus = payload.calendarSyncStatus;
          if (payload.bookingId) bookingId = payload.bookingId;
          if (payload.hasMeetLink && payload.meetLink) meetingLink = payload.meetLink;
        } else if (step === 'Meet Link Generated') {
          if (payload.meetLink) meetingLink = payload.meetLink;
          if (payload.bookingId) bookingId = payload.bookingId;
        } else if (step === 'Invitation Sent') {
          if (log.status === 'success') {
            emailStatus = 'SENT';
          } else {
            emailStatus = 'FAILED';
          }
          if (payload.bookingId) bookingId = payload.bookingId;
          if (payload.meetLink) meetingLink = payload.meetLink;
        } else if (step === 'Booking Request') {
          if (payload.bookingId) bookingId = payload.bookingId;
        } else if (step === 'Availability Applied') {
          if (payload.bookingId) bookingId = payload.bookingId;
          if (payload.status) bookingStatus = payload.status;
        }
      } else {
        const isWebhook = String(log.component).toLowerCase() === 'webhook';
        const isSaveFeedback = String(log.name || log.toolName || log.requestPayload?.name || '').toLowerCase() === 'save_feedback';
        if (isWebhook || isSaveFeedback) {
          const payload = log.requestPayload?.arguments || log.requestPayload || log.responsePayload || {};
          if (payload.customerFeedback || payload.preferredBHK || payload.preferredPropertyType) {
            customerFeedback = payload.customerFeedback || customerFeedback;
            preferredBHK = payload.preferredBHK || preferredBHK;
            preferredPropertyType = payload.preferredPropertyType || preferredPropertyType;
            feedbackCollected = 1;
            presentationCompleted = 1;
          }
        }
      }
    }

    // Auto-detect presentation completed from logs
    const logTextCombined = logs.map(l => String(l.transcript || l.callSummary || l.summary || '')).join(' ').toLowerCase();
    if (
      logTextCombined.includes('presentation') || 
      logTextCombined.includes('project features') || 
      logTextCombined.includes('amenities') || 
      logTextCombined.includes('apartment options') ||
      feedbackCollected === 1
    ) {
      presentationCompleted = 1;
    }

    // Update feedback fields in database if collected or presentation completed
    if (presentationCompleted === 1 || feedbackCollected === 1) {
      await dbRun(
        `UPDATE LEADS SET customer_feedback = ?, preferred_bhk = ?, preferred_property_type = ?, presentation_completed = ?, feedback_collected = ?, updated_at = ? WHERE id = ?`,
        [customerFeedback, preferredBHK, preferredPropertyType, presentationCompleted, feedbackCollected, new Date().toISOString(), lead.id]
      );
      // Update local lead object
      lead.customer_feedback = customerFeedback;
      lead.preferred_bhk = preferredBHK;
      lead.preferred_property_type = preferredPropertyType;
      lead.presentation_completed = presentationCompleted;
      lead.feedback_collected = feedbackCollected;
    }

    if (!lead.email) {
      emailStatus = 'FAILED';
      console.error(`[SYNC SAMUEL ERROR] Original lead.email is missing for lead ID: ${lead.id}. Email marked as FAILED.`);
    }

    if ((bookingId || bookingStatus === 'confirmed' || bookingStatus === 'CONFIRMED') && !meetingLink) {
      emailStatus = 'FAILED';
      console.error(`[SYNC SAMUEL ERROR] Real Google Meet URL is missing from SnapServe response for call ${samuelCallId}. Raw response logs:`, JSON.stringify(logs, null, 2));
    }

    console.log(`[SYNC SAMUEL] Extracted: bookingId=${bookingId}, meetLink=${meetingLink}, slot=${meetingTime}, bookingStatus=${bookingStatus}, calendarSync=${calendarSyncStatus}, emailStatus=${emailStatus}`);

    // If booking was confirmed or we found a meet link/bookingId
    if (bookingId || meetingLink) {
      const existingMeeting = await dbGet('SELECT * FROM MEETINGS WHERE snapserve_call_id = ?', [samuelCallId]);
      
      const dbStatus = String(bookingStatus).toUpperCase() === 'CONFIRMED' ? 'BOOKED' : 'FAILED';
      
      if (!existingMeeting) {
        await dbRun(
          `INSERT INTO MEETINGS (id, lead_id, snapserve_call_id, status, meeting_time, meeting_link, booking_id, email_status, calendar_sync_status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            `meeting-${Date.now()}`,
            lead.id,
            samuelCallId,
            dbStatus,
            meetingTime,
            meetingLink,
            bookingId,
            emailStatus,
            calendarSyncStatus,
            new Date().toISOString(),
            new Date().toISOString()
          ]
        );
      } else {
        await dbRun(
          `UPDATE MEETINGS SET status = ?, meeting_time = ?, meeting_link = ?, booking_id = ?, email_status = ?, calendar_sync_status = ?, updated_at = ? WHERE snapserve_call_id = ?`,
          [
            dbStatus,
            meetingTime,
            meetingLink,
            bookingId,
            emailStatus,
            calendarSyncStatus,
            new Date().toISOString(),
            samuelCallId
          ]
        );
      }

      // Update lead meeting and interest status
      const isBooked = dbStatus === 'BOOKED';
      await dbRun(
        `UPDATE LEADS SET meeting_status = ?, lead_status = ?, interested = ?, updated_at = ? WHERE id = ?`,
        [dbStatus, isBooked ? 'INTERESTED' : lead.lead_status, isBooked ? 1 : lead.interested, new Date().toISOString(), lead.id]
      );
      console.log(`[MEETING] Synced Samuel booking details successfully for lead: ${lead.name}. Status: ${dbStatus}`);
    } else {
      console.log(`[SYNC SAMUEL] No confirmed booking details found in logs yet for call ${samuelCallId}.`);
    }
  } catch (err) {
    console.error(`[SYNC SAMUEL ERROR] Failed to sync Samuel booking details for call ${samuelCallId}:`, err.message);
  }
}

// --- Core Sync Calls & Handoff Meetings Process ---
async function syncCallsAndMeetings() {
  try {
    const snapCalls = await fetchSnapServeCalls();
    if (!Array.isArray(snapCalls)) {
      console.warn('[SYNC WARNING] snapCalls is not an array (likely rate limited). Skipping sync.', snapCalls);
      return;
    }

    const leads = await dbAll('SELECT * FROM LEADS');

    for (const lead of leads) {
      // Self-healing: if the lead has a stored snapserve_call_id, check if that call was busy/failed,
      // and look for a successful sibling call triggered around the same time.
      if (lead.snapserve_call_id) {
        const storedCall = snapCalls.find(call => {
          const cId = call.id || call.callId || call.executionId;
          return String(cId) === String(lead.snapserve_call_id);
        });

        if (storedCall && ['failed', 'busy', 'no_answer', 'cancelled', 'no_pickup'].includes(String(storedCall.status).toLowerCase())) {
          const leadPhone = String(lead.phone || '').replace(/[^0-9]/g, '');
          const leadTime = new Date(lead.created_at).getTime();

          const siblingCall = snapCalls.find(call => {
            const cId = call.id || call.callId || call.executionId;
            if (String(cId) === String(lead.snapserve_call_id)) return false;

            const callAgentId = call.agentId || call.agent_id;
            if (String(callAgentId) !== String(SNAPSERVE_LEAD_AGENT_ID)) return false;

            const callPhone = String(call.phone || call.toNumber || call.to_number || '').replace(/[^0-9]/g, '');
            if (!callPhone || !leadPhone || !callPhone.endsWith(leadPhone)) return false;

            const callTime = new Date(call.createdAt || call.started_at || call.startedAt).getTime();
            const timeDifferenceMs = Math.abs(callTime - leadTime);
            if (timeDifferenceMs > 2 * 60 * 1000) return false;

            return ['completed', 'in_progress', 'ringing'].includes(String(call.status).toLowerCase());
          });

          if (siblingCall) {
            const siblingId = siblingCall.id || siblingCall.callId || siblingCall.executionId;
            const alreadyClaimed = await dbGet('SELECT id FROM LEADS WHERE snapserve_call_id = ?', [siblingId]);
            if (alreadyClaimed) {
              console.log(`[SYNC SELF-HEAL] Sibling call ${siblingId} already claimed by lead ${alreadyClaimed.id}. Skipping.`);
            } else {
              console.log(`[SYNC SELF-HEAL] Lead ${lead.name} call ID ${lead.snapserve_call_id} was ${storedCall.status}. Sibling call ${siblingId} is ${siblingCall.status}. Updating snapserve_call_id.`);
              await dbRun(
                `UPDATE LEADS SET snapserve_call_id = ?, updated_at = ? WHERE id = ?`,
                [siblingId, new Date().toISOString(), lead.id]
              );
              lead.snapserve_call_id = siblingId;
            }
          }
        }
      }

      // 1. Match and sync Robert (Lead Qualifier, ID 596) calls
      const robertMatch = snapCalls.find(call => {
        const cId = call.id || call.callId || call.executionId;
        const callAgentId = call.agentId || call.agent_id;
        const callPhone = String(call.phone || call.toNumber || call.to_number || '').replace(/[^0-9]/g, '');
        const leadPhone = String(lead.phone || '').replace(/[^0-9]/g, '');

        // Verify Robert Agent ID (596)
        if (String(callAgentId) !== String(SNAPSERVE_LEAD_AGENT_ID)) {
          return false;
        }

        // If the lead already has a call ID, only match the exact call ID
        if (lead.snapserve_call_id) {
          return String(cId) === String(lead.snapserve_call_id);
        }

        // Skip if already processed to avoid matching new calls to old leads
        if (lead.call_status === 'COMPLETED' || lead.call_status === 'FAILED') {
          return false;
        }
        
        // Otherwise, fall back to matching by phone number + agent ID + timing window
        if (callPhone && leadPhone && callPhone.endsWith(leadPhone)) {
          // Verify call started after lead was created, or at most 30 seconds before (allow clock differences)
          const callTime = new Date(call.createdAt || call.started_at || call.startedAt).getTime();
          const leadTime = new Date(lead.created_at).getTime();
          const timeDifferenceMs = callTime - leadTime;
          if (timeDifferenceMs >= -30000 && timeDifferenceMs <= 3 * 60 * 1000) {
            return true;
          }
        }
        return false;
      });

      if (robertMatch) {
        try {
          const matchedCallId = robertMatch.id || robertMatch.callId || robertMatch.executionId;
          const rawStatus = robertMatch.status; // completed, failed, ringing, in_progress, busy, no_pickup
          
          console.log(`[MCP] Found call: ${matchedCallId}`);
          console.log(`[MCP] Agent ID: 596`);
          console.log(`[MCP] Status: ${rawStatus}`);

          let newCallStatus = 'TRIGGERED';
          let terminal = false;

          if (String(rawStatus).toLowerCase() === 'completed') {
            newCallStatus = 'COMPLETED';
            terminal = true;
          } else if (['failed', 'busy', 'no_answer', 'cancelled', 'no_pickup'].includes(String(rawStatus).toLowerCase())) {
            newCallStatus = String(rawStatus).toUpperCase();
            terminal = true;
          } else if (String(rawStatus).toLowerCase() === 'in_progress') {
            newCallStatus = 'IN_PROGRESS';
          } else if (['ringing', 'triggered', 'initiated'].includes(String(rawStatus).toLowerCase())) {
            newCallStatus = 'RINGING';
          }

          // Print debug representations
          console.log(`[MCP] Transcript available: ${!!robertMatch.transcript}`);
          console.log(`[MCP] Summary available: ${!!robertMatch.callSummary}`);
          console.log(`[MCP] Recording available: ${!!robertMatch.recordingUrl}`);

          if (!robertMatch.transcript) console.log(`[MCP] Transcript field missing`);
          if (!robertMatch.callSummary) console.log(`[MCP] Summary field missing`);
          if (!robertMatch.recordingUrl) console.log(`[MCP] Recording field missing`);

          // Nullify if missing or placeholders as required
          const summaryText = robertMatch.callSummary || robertMatch.summary || null;
          const transcriptText = robertMatch.transcript || null;
          const formattedDuration = robertMatch.durationSeconds !== null && robertMatch.durationSeconds !== undefined ? `${robertMatch.durationSeconds}s` : null;
          const absoluteRecordingUrl = robertMatch.recordingUrl ? (robertMatch.recordingUrl.startsWith('http') ? robertMatch.recordingUrl : `https://app.snapserve.ai${robertMatch.recordingUrl}`) : null;
          
          // Save Call Log Details
          const logId = `log-${Date.now()}`;
          const existingLog = await dbGet('SELECT * FROM CALL_LOGS WHERE snapserve_call_id = ?', [matchedCallId]);
          if (!existingLog) {
            await dbRun(
              `INSERT INTO CALL_LOGS (id, lead_id, snapserve_call_id, agent_id, agent_name, status, duration, started_at, ended_at, summary, transcript, recording_url, raw_snapserve_data, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'Robert', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [logId, lead.id, matchedCallId, SNAPSERVE_LEAD_AGENT_ID, rawStatus, formattedDuration, robertMatch.createdAt, robertMatch.endedAt, summaryText, transcriptText, absoluteRecordingUrl, JSON.stringify(robertMatch), new Date().toISOString(), new Date().toISOString()]
            );
          } else {
            await dbRun(
              `UPDATE CALL_LOGS SET status = ?, duration = ?, started_at = ?, ended_at = ?, summary = ?, transcript = ?, recording_url = ?, raw_snapserve_data = ?, updated_at = ? WHERE snapserve_call_id = ?`,
              [rawStatus, formattedDuration, robertMatch.createdAt, robertMatch.endedAt, summaryText, transcriptText, absoluteRecordingUrl, JSON.stringify(robertMatch), new Date().toISOString(), matchedCallId]
            );
          }

          // Detect interest from conversation transcript/summary using business rules
          let interested = lead.interested;
          let leadStatus = lead.lead_status;

          if (terminal && newCallStatus === 'COMPLETED' && (summaryText || transcriptText)) {
            const textToAnalyze = ((summaryText || '') + ' ' + (transcriptText || '')).toLowerCase();
            if (
              textToAnalyze.includes('interested') || 
              textToAnalyze.includes('schedule') || 
              textToAnalyze.includes('site visit') || 
              textToAnalyze.includes('viewing') ||
              textToAnalyze.includes('samuel') ||
              textToAnalyze.includes('meeting agent') ||
              textToAnalyze.includes('transfer') ||
              textToAnalyze.includes('continue') ||
              textToAnalyze.includes('proceed') ||
              textToAnalyze.includes('next steps') ||
              textToAnalyze.includes('take this forward') ||
              textToAnalyze.includes('have a meeting')
            ) {
              interested = 1;
              leadStatus = 'INTERESTED';
            } else if (textToAnalyze.includes('not interested') || textToAnalyze.includes('no interest') || textToAnalyze.includes('wrong number')) {
              interested = 0;
              leadStatus = 'NOT_INTERESTED';
            } else if (textToAnalyze.includes('follow-up') || textToAnalyze.includes('call back')) {
              interested = 0;
              leadStatus = 'FOLLOW_UP';
            }
          }

          // Verify whether another lead already owns this call ID before updating
          const conflictingLead = await dbGet('SELECT id FROM LEADS WHERE snapserve_call_id = ? AND id != ?', [matchedCallId, lead.id]);
          if (conflictingLead) {
            console.log(`[SYNC] Call ${matchedCallId} already belongs to lead ${conflictingLead.id}`);
            console.log(`[SYNC] Skipping conflicting lead match`);
          } else {
            // Update Leads table - ONLY MARK COMPLETED if snapserve matches terminal status and we verify it
            await dbRun(
              `UPDATE LEADS SET call_status = ?, snapserve_call_id = ?, interested = ?, lead_status = ?, updated_at = ? WHERE id = ?`,
              [newCallStatus, matchedCallId, interested, leadStatus, new Date().toISOString(), lead.id]
            );

            if (terminal) {
              console.log(`[DATABASE] Call status = ${newCallStatus}`);
              if (newCallStatus === 'COMPLETED') {
                console.log(`[DATABASE] Transcript saved`);
                console.log(`[DATABASE] Summary saved`);
                console.log(`[DATABASE] Recording saved`);
              }
              console.log(`[DB] Call ${matchedCallId} synced successfully`);
            }
          }
        } catch (singleErr) {
          console.error(`[SYNC ERROR] Failed to sync Robert call details for lead ${lead.id}:`, singleErr.message);
        }
      }

      // 1.5. Check if booking happened in Robert call (internal squad handoff)
      const currentMeetingStatus = String(lead.meeting_status || '').toUpperCase();
      const isAlreadyBooked = currentMeetingStatus === 'BOOKED' || currentMeetingStatus === 'CONFIRMED';
      if (lead.snapserve_call_id && !lead.samuel_call_id && !isAlreadyBooked) {
        try {
          await syncSamuelBooking(lead, lead.snapserve_call_id, robertMatch);
          // Refresh lead object from DB to get updated fields
          const updatedLead = await dbGet('SELECT * FROM LEADS WHERE id = ?', [lead.id]);
          if (updatedLead) {
            lead.meeting_status = updatedLead.meeting_status;
            lead.lead_status = updatedLead.lead_status;
            lead.interested = updatedLead.interested;
          }
        } catch (err) {
          console.log(`[SYNC] Checking Robert call ${lead.snapserve_call_id} logs for booking returned: ${err.message}`);
        }
      }

      // 2. Sync Samuel (Meeting Scheduler, ID 597) calls to match booked meetings
      let samuelCallIdToSync = lead.samuel_call_id;
      let samuelMatch = null;

      if (samuelCallIdToSync) {
        samuelMatch = snapCalls.find(call => {
          const cId = call.id || call.callId || call.executionId;
          return String(cId) === String(samuelCallIdToSync);
        });
      }

      if (samuelMatch) {
        const samuelCallId = samuelMatch.id || samuelMatch.callId || samuelMatch.executionId;
        const samuelStatus = samuelMatch.status;

        if (!lead.samuel_call_id) {
          await dbRun(
            `UPDATE LEADS SET samuel_call_id = ?, updated_at = ? WHERE id = ?`,
            [samuelCallId, new Date().toISOString(), lead.id]
          );
          lead.samuel_call_id = samuelCallId;
        }

        if (String(samuelStatus).toLowerCase() === 'completed') {
          await syncSamuelBooking(lead, samuelCallId, samuelMatch);
        } else if (['failed', 'busy', 'no_answer', 'cancelled', 'no_pickup'].includes(String(samuelStatus).toLowerCase())) {
          await dbRun(
            `UPDATE LEADS SET meeting_status = 'FAILED', updated_at = ? WHERE id = ?`,
            [new Date().toISOString(), lead.id]
          );
          await dbRun(
            `UPDATE MEETINGS SET status = 'FAILED', updated_at = ? WHERE snapserve_call_id = ?`,
            [new Date().toISOString(), samuelCallId]
          );
        }
      }

      // 3. Samuel outbound call trigger has been disabled. Booking is handled directly by Robert.

      // 4. Sync Scheduled Meetings / AI-hosted meetings (meetbot calls)
      try {
        const meetings = await dbAll('SELECT * FROM MEETINGS WHERE lead_id = ? AND status IN (\'BOOKED\', \'PENDING\')', [lead.id]);
        for (const meeting of meetings) {
          if (!meeting.meeting_link) continue;
          
          // Find a call in snapCalls that is a meetbot call and matches the meeting link
          const meetbotMatch = snapCalls.find(call => {
            const callAgentId = call.agentId || call.agent_id;
            
            // Must correspond to Samuel (Agent 597)
            if (String(callAgentId) !== String(SNAPSERVE_MEETING_AGENT_ID)) return false;
            
            let metadata = {};
            if (call.metadata) {
              try {
                metadata = typeof call.metadata === 'string' ? JSON.parse(call.metadata) : call.metadata;
              } catch (e) {}
            }
            
            const callMeetUrl = metadata.meetUrl || metadata.meetLink || call.meetUrl || call.meetLink || '';
            
            if (callMeetUrl && meeting.meeting_link && String(callMeetUrl).trim() === String(meeting.meeting_link).trim()) {
              return true;
            }
            return false;
          });

          if (meetbotMatch) {
            let currentLead = lead;
            const meetbotCallId = meetbotMatch.id || meetbotMatch.callId || meetbotMatch.executionId;
            const rawStatus = meetbotMatch.status;
            
            // Save call logs for the meetbot call so they display on the dashboard!
            const logId = `log-${Date.now()}`;
            const existingLog = await dbGet('SELECT * FROM CALL_LOGS WHERE snapserve_call_id = ?', [meetbotCallId]);
            const summaryText = meetbotMatch.callSummary || meetbotMatch.summary || null;
            const transcriptText = meetbotMatch.transcript || null;
            const formattedDuration = meetbotMatch.durationSeconds !== null && meetbotMatch.durationSeconds !== undefined ? `${meetbotMatch.durationSeconds}s` : null;
            const absoluteRecordingUrl = meetbotMatch.recordingUrl ? (meetbotMatch.recordingUrl.startsWith('http') ? meetbotMatch.recordingUrl : `https://app.snapserve.ai${meetbotMatch.recordingUrl}`) : null;
            
            if (!existingLog) {
              await dbRun(
                `INSERT INTO CALL_LOGS (id, lead_id, snapserve_call_id, agent_id, agent_name, status, duration, started_at, ended_at, summary, transcript, recording_url, raw_snapserve_data, created_at, updated_at)
                 VALUES (?, ?, ?, ?, 'CASAGRAND Meeting Bot', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [logId, currentLead.id, meetbotCallId, SNAPSERVE_MEETING_AGENT_ID, rawStatus, formattedDuration, meetbotMatch.createdAt, meetbotMatch.endedAt, summaryText, transcriptText, absoluteRecordingUrl, JSON.stringify(meetbotMatch), new Date().toISOString(), new Date().toISOString()]
              );
            } else {
              await dbRun(
                `UPDATE CALL_LOGS SET status = ?, duration = ?, started_at = ?, ended_at = ?, summary = ?, transcript = ?, recording_url = ?, raw_snapserve_data = ?, updated_at = ? WHERE snapserve_call_id = ?`,
                [rawStatus, formattedDuration, meetbotMatch.createdAt, meetbotMatch.endedAt, summaryText, transcriptText, absoluteRecordingUrl, JSON.stringify(meetbotMatch), new Date().toISOString(), meetbotCallId]
              );
            }

            if (String(rawStatus).toLowerCase() === 'completed') {
              // Update meeting status in database
              await dbRun(
                `UPDATE MEETINGS SET status = 'COMPLETED', updated_at = ? WHERE id = ?`,
                [new Date().toISOString(), meeting.id]
              );
              
              // Parse meetbot logs to extract feedback
              try {
                await syncSamuelBooking(currentLead, meetbotCallId, meetbotMatch);
                const reloadedLead = await dbGet('SELECT * FROM LEADS WHERE id = ?', [currentLead.id]);
                if (reloadedLead) {
                  currentLead = reloadedLead;
                }
              } catch (feedbackErr) {
                console.error(`[SYNC MEETBOT] Failed to parse logs/feedback:`, feedbackErr.message);
              }

              // Analyze transcript/summary for customer interest
              let isInterested = false;
              if (summaryText || transcriptText) {
                const textToAnalyze = ((summaryText || '') + ' ' + (transcriptText || '')).toLowerCase();
                if (textToAnalyze.includes('interested') || textToAnalyze.includes('positive') || textToAnalyze.includes('buy') || textToAnalyze.includes('yes') || textToAnalyze.includes('proceed') || textToAnalyze.includes('likes the property')) {
                  isInterested = true;
                }
              }

              if (isInterested) {
                await dbRun(
                  `UPDATE LEADS SET lead_status = 'INTERESTED', interested = 1, updated_at = ? WHERE id = ?`,
                  [new Date().toISOString(), currentLead.id]
                );
                console.log(`[MEETING] Attendee ${currentLead.name} marked as INTERESTED from AI meeting logs.`);
                await syncToGoogleSheets(currentLead, meeting, 'Interested');
              } else {
                await dbRun(
                  `UPDATE LEADS SET lead_status = 'NOT_INTERESTED', interested = 0, updated_at = ? WHERE id = ?`,
                  [new Date().toISOString(), currentLead.id]
                );
                console.log(`[MEETING] Attendee ${currentLead.name} marked as NOT_INTERESTED from AI meeting logs.`);
                await syncToGoogleSheets(currentLead, meeting, 'Not Interested');
              }
            } else if (['failed', 'busy', 'no_answer', 'cancelled', 'no_pickup'].includes(String(rawStatus).toLowerCase())) {
              await dbRun(
                `UPDATE MEETINGS SET status = 'FAILED', updated_at = ? WHERE id = ?`,
                [new Date().toISOString(), meeting.id]
              );
              await syncToGoogleSheets(currentLead, meeting, 'Failed');
            }
          }
        }
      } catch (meetSyncErr) {
        console.error(`[SYNC ERROR] Failed to sync meeting/meetbot status for lead ${lead.id}:`, meetSyncErr.message);
      }
    }
  } catch (err) {
    console.error(`[SYNC ERROR] failed to complete synchronization: ${err.message}`);
  }
}

// Start background polling loop every 60 seconds for development to prevent rate limiting
setInterval(() => {
  syncCallsAndMeetings().catch(err => console.error('[SYNC ERROR] background interval sync failed:', err.message));
}, 60000);

// --- Background Polling Wrapper for form submissions ---
const activePollers = new Map();

function startCallPolling(leadId, _callId, _phone) {
  if (activePollers.has(leadId)) {
    clearTimeout(activePollers.get(leadId));
  }

  const startTime = Date.now();
  const pollIntervalMs = 5000;
  const maxDurationMs = 3 * 60 * 1000; // 3 minutes maximum timeout

  const poll = async () => {
    try {
      await syncCallsAndMeetings();
      // Check if lead reached completed or failed
      const lead = await dbGet('SELECT * FROM LEADS WHERE id = ?', [leadId]);
      if (lead && ['COMPLETED', 'FAILED', 'NO_ANSWER', 'BUSY', 'CANCELLED'].includes(lead.call_status)) {
        activePollers.delete(leadId);
        return;
      }
    } catch (err) {
      console.error(`[POLLER ERROR] Polling iteration failed: ${err.message}`);
    }

    if (Date.now() - startTime >= maxDurationMs) {
      console.log(`[POLLER] Polling timeout reached for lead ${leadId}.`);
      activePollers.delete(leadId);
      return;
    }

    const timeoutId = setTimeout(poll, pollIntervalMs);
    activePollers.set(leadId, timeoutId);
  };

  poll();
}

// Resume active pollers at backend startup
async function resumePollers() {
  try {
    const activeLeads = await dbAll("SELECT * FROM LEADS WHERE call_status IN ('PENDING', 'TRIGGERED', 'RINGING', 'IN_PROGRESS')");
    console.log(`[POLLER] Resuming pollers for ${activeLeads.length} active leads...`);
    for (const lead of activeLeads) {
      startCallPolling(lead.id, lead.snapserve_call_id, lead.phone);
    }
  } catch (err) {
    console.error('[POLLER] Failed to resume pollers:', err.message);
  }
}

// --- Express API Endpoints ---

// GET /api/admin/leads
app.get('/api/admin/leads', async (req, res) => {
  try {
    const leads = await dbAll(`
      SELECT 
        LEADS.*, 
        MEETINGS.meeting_time, 
        MEETINGS.meeting_link
      FROM LEADS
      LEFT JOIN MEETINGS ON LEADS.id = MEETINGS.lead_id
      ORDER BY LEADS.created_at DESC
    `);
    res.json(leads.map(normalizeLead));
  } catch (err) {
    console.error('[LEAD] Fetch leads error:', err.message);
    res.status(500).json({ error: 'Failed to fetch leads from database' });
  }
});

// GET /api/admin/calls
const handleGetCalls = async (req, res) => {
  try {
    const logs = await dbAll(`
      SELECT 
        CALL_LOGS.lead_id AS leadId,
        LEADS.name,
        LEADS.phone,
        CALL_LOGS.snapserve_call_id AS callId,
        CALL_LOGS.agent_id AS agentId,
        CALL_LOGS.status,
        CALL_LOGS.duration,
        CALL_LOGS.summary,
        CALL_LOGS.transcript,
        CALL_LOGS.recording_url AS recordingUrl,
        CALL_LOGS.started_at AS startedAt,
        CALL_LOGS.ended_at AS endedAt
      FROM CALL_LOGS
      JOIN LEADS ON CALL_LOGS.lead_id = LEADS.id
      ORDER BY CALL_LOGS.created_at DESC
    `);
    
    const mappedLogs = logs.map(callLog => {
      const absRecordingUrl = callLog.recordingUrl ? (callLog.recordingUrl.startsWith('http') ? callLog.recordingUrl : `https://app.snapserve.ai${callLog.recordingUrl}`) : null;
      return {
        callId: callLog.callId,
        snapserve_call_id: callLog.callId,
        agentId: callLog.agentId,
        agent_id: callLog.agentId,
        startedAt: callLog.startedAt,
        started_at: callLog.startedAt,
        endedAt: callLog.endedAt,
        ended_at: callLog.endedAt,
        recordingUrl: absRecordingUrl,
        recording_url: absRecordingUrl,
        transcript: callLog.transcript,
        summary: callLog.summary,
        duration: callLog.duration,
        durationSeconds: callLog.duration ? parseInt(callLog.duration) : null,
        status: callLog.status,
        leadId: callLog.leadId,
        name: callLog.name,
        phone: callLog.phone
      };
    });
    
    res.json({ calls: mappedLogs });
  } catch (err) {
    console.error('[CALL] Fetch calls error:', err.message);
    res.status(500).json({ error: 'Failed to fetch call logs' });
  }
};

app.get('/api/admin/calls', handleGetCalls);
app.get('/api/calls', handleGetCalls);

// GET /api/admin/calls/:callId
app.get('/api/admin/calls/:callId', async (req, res) => {
  try {
    const callLog = await dbGet('SELECT * FROM CALL_LOGS WHERE snapserve_call_id = ?', [req.params.callId]);
    if (callLog) {
      const absRecordingUrl = callLog.recording_url ? (callLog.recording_url.startsWith('http') ? callLog.recording_url : `https://app.snapserve.ai${callLog.recording_url}`) : null;
      const mapped = {
        callId: callLog.snapserve_call_id,
        snapserve_call_id: callLog.snapserve_call_id,
        agentId: callLog.agent_id,
        agent_id: callLog.agent_id,
        startedAt: callLog.started_at,
        started_at: callLog.started_at,
        endedAt: callLog.ended_at,
        ended_at: callLog.ended_at,
        recordingUrl: absRecordingUrl,
        recording_url: absRecordingUrl,
        transcript: callLog.transcript,
        summary: callLog.summary,
        duration: callLog.duration,
        durationSeconds: callLog.duration ? parseInt(callLog.duration) : null,
        status: callLog.status,
        leadId: callLog.lead_id
      };
      res.json({ call: mapped });
    } else {
      res.json({ call: null });
    }
  } catch (err) {
    console.error('[CALL] Fetch call log error:', err.message);
    res.status(500).json({ error: 'Failed to fetch call details' });
  }
});

// POST /api/leads
app.post('/api/leads', async (req, res) => {
  try {
    const { name, phone, email, location, lookingFor, propertyType, bedrooms, budget, callbackTime } = req.body;
    
    if (!name || !phone || !email || !location) {
      return res.status(400).json({ success: false, error: 'Name, phone, email, and location are required.' });
    }

    // --- Duplicate Prevention ---
    try {
      const existing = await dbGet(
        "SELECT * FROM LEADS WHERE phone = ? ORDER BY created_at DESC LIMIT 1",
        [phone]
      );
      if (existing) {
        const elapsedMs = Date.now() - new Date(existing.created_at).getTime();
        if (elapsedMs < 60000) { // 1 minute duplicate protection window
          console.log(`[LEAD] Lead already exists with Call ID ${existing.snapserve_call_id}. Duplicate trigger prevented.`);
          return res.json({
            success: true,
            message: 'Lead already exists and call is already triggered.',
            lead: normalizeLead(existing),
            triggerSuccess: true
          });
        }
      }
    } catch (err) {
      console.error('[LEAD] Duplicate check error:', err.message);
    }

    const id = `lead-${Date.now()}`;
    const createdAt = new Date().toISOString();
    console.log(`[LEAD] Created lead ID: ${id}`);

    // Format combined property requirements
    const requirementStr = `${lookingFor || 'Buy'} — ${bedrooms || '2 BHK'} ${propertyType || 'Apartment'}, ${budget || 'Below ₹50 Lakhs'} (Callback: ${callbackTime || 'Evening'})`;

    // 1. Immediately save lead to database (NEW, PENDING)
    await dbRun(
      `INSERT INTO LEADS (id, name, phone, email, location, requirement, lead_status, call_status, meeting_status, interested, snapserve_lead_agent_id, snapserve_meeting_agent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'NEW', 'PENDING', 'NOT_BOOKED', 0, ?, ?, ?, ?)`,
      [id, name, phone, email, location, requirementStr, SNAPSERVE_LEAD_AGENT_ID, SNAPSERVE_MEETING_AGENT_ID, createdAt, createdAt]
    );

    const tempLead = {
      id,
      name,
      phone,
      email,
      location,
      requirement: requirementStr,
      lookingFor: lookingFor || 'Buy',
      propertyType: propertyType || 'Apartment',
      bedrooms: bedrooms || '2 BHK',
      budget: budget || 'Below ₹50 Lakhs',
      preferredCallbackTime: callbackTime || 'Evening'
    };

    const tempCallId = `temp-call-${Date.now()}`;
    
    // Create initial log details placeholder with status TRIGGERED
    try {
      const logId = `log-${Date.now()}`;
      await dbRun(
        `INSERT INTO CALL_LOGS (id, lead_id, snapserve_call_id, agent_id, agent_name, status, duration, started_at, ended_at, summary, transcript, recording_url, raw_snapserve_data, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'Robert', 'TRIGGERED', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
        [logId, id, tempCallId, SNAPSERVE_LEAD_AGENT_ID, new Date().toISOString(), new Date().toISOString()]
      );
      
      await dbRun(
        `UPDATE LEADS SET call_status = 'TRIGGERED', snapserve_call_id = ?, updated_at = ? WHERE id = ?`,
        [tempCallId, new Date().toISOString(), id]
      );
      console.log(`[DATABASE] Lead ${id} call status initialized to TRIGGERED with placeholder ID ${tempCallId}`);
    } catch (err) {
      console.error('[LEAD] Failed to initialize call logs placeholder:', err.message);
    }

    // 2. Perform Webhook submission and Robert call trigger asynchronously in the background
    (async () => {
      try {
        // Submit lead to the official SnapServe Lead Capture Webhook
        const webhookUrl = 'https://app.snapserve.ai/api/webhooks/lead/bff65d58-e26d-45ac-9c01-a16c60265018';
        const formattedPhone = formatToE164(phone);
        console.log(`[LEAD ASYNC] Submitting to lead capture: name="${name}", phone="${formattedPhone}", email="${email}"`);
        
        const webhookRes = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phone: formattedPhone,
            name: name,
            email: email
          })
        });
        console.log(`[LEAD ASYNC] Webhook Response: ${webhookRes.status} ${webhookRes.statusText}`);
      } catch (err) {
        console.error(`[LEAD ASYNC ERROR] Failed to send lead to webhook:`, err.message);
      }

      try {
        console.log(`[LEAD ASYNC] Triggering Robert outbound call...`);
        const triggerRes = await triggerSnapServeCall(phone, tempLead);
        const actualCallId = triggerRes.id || triggerRes.callId || triggerRes.executionId || null;
        
        if (actualCallId) {
          console.log(`[LEAD ASYNC] Robert call triggered successfully. Call ID: ${actualCallId}`);
          
          // Update database with the actual call ID
          await dbRun(
            `UPDATE LEADS SET snapserve_call_id = ?, updated_at = ? WHERE id = ?`,
            [actualCallId, new Date().toISOString(), id]
          );
          
          // Update call log placeholder with the actual call ID
          await dbRun(
            `UPDATE CALL_LOGS SET snapserve_call_id = ?, updated_at = ? WHERE lead_id = ? AND snapserve_call_id = ?`,
            [actualCallId, new Date().toISOString(), id, tempCallId]
          );

          // Start background polling for the actual call ID
          startCallPolling(id, actualCallId, phone);
        } else {
          console.warn(`[LEAD ASYNC WARNING] No actual call ID returned for Robert trigger. Reverting.`);
          await dbRun(
            `UPDATE LEADS SET call_status = 'FAILED', updated_at = ? WHERE id = ?`,
            [new Date().toISOString(), id]
          );
        }
      } catch (err) {
        console.error(`[LEAD ASYNC ERROR] Failed to trigger Robert's call:`, err.message);
        await dbRun(
          `UPDATE LEADS SET call_status = 'FAILED', updated_at = ? WHERE id = ?`,
          [new Date().toISOString(), id]
        );
      }
    })().catch(err => console.error('[LEAD ASYNC CRITICAL ERROR]:', err));

    // Retrieve saved lead from DB to send as response
    const savedLead = await dbGet('SELECT * FROM LEADS WHERE id = ?', [id]);
    const normalizedSavedLead = normalizeLead(savedLead);

    // Return success response to client immediately
    return res.json({
      success: true,
      message: 'Lead saved and call trigger initiated successfully',
      lead: normalizedSavedLead,
      triggerSuccess: true
    });
  } catch (error) {
    console.error('[LEAD] Lead submission error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'An internal server error occurred while processing lead'
    });
  }
});

// POST /api/leads/:id/status (to support manual overrides in dashboard)
app.post('/api/leads/:id/status', async (req, res) => {
  const { callStatus, meetingStatus, leadStatus } = req.body;
  try {
    const lead = await dbGet('SELECT * FROM LEADS WHERE id = ?', [req.params.id]);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    let query = 'UPDATE LEADS SET ';
    const params = [];
    const updates = [];

    if (callStatus !== undefined) {
      updates.push('call_status = ?');
      params.push(callStatus);
    }
    if (meetingStatus !== undefined) {
      updates.push('meeting_status = ?');
      params.push(meetingStatus);
    }
    if (leadStatus !== undefined) {
      updates.push('lead_status = ?');
      params.push(leadStatus);
    }

    if (updates.length === 0) {
      return res.json(normalizeLead(lead));
    }

    query += updates.join(', ') + ', updated_at = ? WHERE id = ?';
    params.push(new Date().toISOString(), req.params.id);

    await dbRun(query, params);
    
    const updatedLead = await dbGet('SELECT * FROM LEADS WHERE id = ?', [req.params.id]);
    res.json(normalizeLead(updatedLead));
  } catch (err) {
    console.error('[LEAD] Update status failed:', err.message);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// POST /api/sync/calls
app.post('/api/sync/calls', async (req, res) => {
  try {
    await syncCallsAndMeetings();
    res.json({ success: true, message: 'Synchronization completed successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/health
app.get('/api/health', async (req, res) => {
  let database = false;
  let mcp = false;
  let snapserve = false;

  try {
    const dbTest = await dbGet("SELECT 1");
    if (dbTest) database = true;
  } catch (e) {
    console.error('Health check DB failed:', e.message);
  }

  try {
    const robert = await verifyAgentIsRobert();
    if (robert) {
      mcp = true;
      snapserve = true;
    }
  } catch (e) {
    console.error('Health check MCP/SnapServe failed:', e.message);
  }

  res.json({
    backend: true,
    database,
    snapserve,
    mcp
  });
});

// GET /api/debug/snapserve
app.get('/api/debug/snapserve', async (req, res) => {
  try {
    console.log('[MCP] Fetching call history');
    const snapCalls = await fetchSnapServeCalls();
    
    res.json({
      success: true,
      count: snapCalls.length,
      calls: snapCalls.map(c => {
        const callAgentId = c.agentId || c.agent_id;
        const cId = c.id || c.callId || c.executionId;
        return {
          id: String(cId),
          agentId: callAgentId,
          status: c.status,
          phone: c.phone || c.toNumber || c.to_number || '',
          hasTranscript: !!c.transcript,
          hasSummary: !!(c.callSummary || c.summary),
          hasRecording: !!c.recordingUrl,
          raw: c
        };
      })
    });
  } catch (err) {
    console.error('[MCP ERROR] Debug calls endpoint failed:', err.message);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// GET /api/debug/last-lead
app.get('/api/debug/last-lead', async (req, res) => {
  try {
    const lead = await dbGet('SELECT * FROM LEADS ORDER BY created_at DESC LIMIT 1');
    if (!lead) {
      return res.json({ message: 'No leads found in database' });
    }
    const callLog = await dbGet('SELECT * FROM CALL_LOGS WHERE lead_id = ?', [lead.id]);
    res.json({
      lead,
      callLog,
      snapserve_call_id: lead.snapserve_call_id,
      agent_id: lead.snapserve_lead_agent_id,
      status: lead.call_status,
      transcript: callLog ? callLog.transcript : null,
      summary: callLog ? callLog.summary : null,
      recording_url: callLog ? callLog.recording_url : null,
      raw_snapserve_response: callLog && callLog.raw_snapserve_data ? JSON.parse(callLog.raw_snapserve_data) : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve frontend static assets if in production
const distPath = nodePath.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('/*splat', (req, res) => {
    res.sendFile(nodePath.join(distPath, 'index.html'));
  });
}

initDb()
  .then(() => {
    resumePollers().catch(console.error);
  })
  .catch(err => console.error('[DB] Initialization failed:', err));

app.listen(PORT, () => {
  console.log(`[SERVER] CASAGRAND Backend running on port ${PORT}`);
});
