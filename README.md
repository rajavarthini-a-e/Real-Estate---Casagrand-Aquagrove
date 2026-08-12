# Real Estate - Casagrand Aquagrove

A finalized customer qualification, property presentation, and automated scheduling platform for the Casagrand Aquagrove waterfront luxury residential project.

## Project Overview
This project automates the real estate lead collection and presentation pipeline using two specialized AI voice agents:
- **Robert** (Agent 596): Qualification and Appointment Booking Agent.
- **Samuel** (Agent 597): Property Presentation and Feedback Agent.

## The Workflow
1. **Lead Form Submission**: The customer enters their details on the web portal.
2. **SnapServe Lead Webhook**: Details are sent instantly to the SnapServe Lead Capture webhook.
3. **Robert's Call**: Robert calls the customer, confirms their name/email, answers questions, discusses Casagrand Aquagrove details, and books a presentation appointment natively via the `book_appointment` tool.
4. **Google Calendar Invite**: An invitation with a Google Meet link is automatically sent to the customer's email.
5. **Scheduled Presentation**: At the scheduled time, Samuel joins the Google Meet as a presenter, reviews layouts/configurations, and collects feedback, which is saved via `save_feedback` to SQLite and synchronized to a 22-column Google Sheet.

## Technologies Used
- **Frontend**: React, Vite, CSS
- **Backend**: Node.js, Express.js
- **Database**: SQLite3
- **Voice Platform**: SnapServe MCP & REST API
- **Scheduling/Email**: Google Calendar API & Google Meet

## Local Setup

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables
Create a `.env` file in the root directory and add the following variable names:
```env
PORT=5000
SNAPSERVE_API_KEY=
SNAPSERVE_BASE_URL=
SNAPSERVE_LEAD_AGENT_ID=
SNAPSERVE_MEETING_AGENT_ID=
SNAPSERVE_MCP_PATH=
GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_PRIVATE_KEY=
GOOGLE_SHEET_ID=
GOOGLE_SHEET_TAB_NAME=
```

### 3. Run the Servers
```bash
# Start both frontend and backend concurrently
npm run dev
```
- **Web Portal (Vite)**: `http://localhost:5173/`
- **Backend API**: `http://localhost:5000/`
