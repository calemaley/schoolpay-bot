// ============================================================
// OFFLINE FLOW SIMULATOR — drives the new Figma flows with
// stubbed Supabase / Paystack / Twilio / Africa's Talking.
// Run: node sim-flows.js
// ============================================================
const Module = require('module')

process.env.SUPABASE_URL = 'http://stub.local'
process.env.SUPABASE_SERVICE_KEY = 'stub'
process.env.TWILIO_ACCOUNT_SID = 'ACstub'
process.env.TWILIO_AUTH_TOKEN = 'stub'
process.env.TWILIO_WHATSAPP_NUMBER = '+10000000000'
process.env.AT_USERNAME = 'sandbox'
process.env.AT_API_KEY = 'stub'
process.env.SCHOOL_ID = 'school-1'
process.env.PAYSTACK_SECRET_KEY = 'sk_stub'
process.env.SCHOOL_NAME = 'School XYZ'

// ── Mock data ────────────────────────────────────────────────
const GUARDIAN_PHONE = '+254712345678'
const DB = {
  students: [{
    id: 'stu-1', school_id: 'school-1', is_active: true,
    first_name: 'Clarence', last_name: 'Kioko Mueni',
    admission_number: 'ADM/2025/001',
    guardian1_name: 'Jane Mueni',
    guardian1_phone: GUARDIAN_PHONE, guardian1_whatsapp: GUARDIAN_PHONE,
    classes: { name: 'Grade 5', stream: 'A' }
  }],
  v_student_fee_summary: [
    { student_id: 'stu-1', student_fee_id: 'sf-1', fee_name: 'Tuition', fee_category: 'a', amount_due: 15000, amount_paid: 0, balance: 15000 },
    { student_id: 'stu-1', student_fee_id: 'sf-2', fee_name: 'Transport', fee_category: 'b', amount_due: 5000, amount_paid: 0, balance: 5000 }
  ],
  payments: [
    { student_id: 'stu-1', status: 'success', amount: 4000, payment_method: 'mpesa', paystack_reference: 'SCH-1', created_at: '2026-05-10T09:00:00Z' },
    { student_id: 'stu-1', status: 'success', amount: 2500, payment_method: 'mpesa', paystack_reference: 'SCH-2', created_at: '2026-06-02T10:00:00Z' }
  ],
  student_results: [
    { student_id: 'stu-1', subject: 'Maths',   exam_type: 'midterm', marks_scored: 80, total_marks: 100, term: 2, year: 2026, created_at: '2026-05-20T08:00:00Z' },
    { student_id: 'stu-1', subject: 'English', exam_type: 'midterm', marks_scored: 60, total_marks: 100, term: 2, year: 2026, created_at: '2026-05-20T08:00:00Z' },
    { student_id: 'stu-1', subject: 'Maths',   exam_type: 'endterm', marks_scored: 70, total_marks: 100, term: 2, year: 2026, created_at: '2026-06-08T08:00:00Z' }
  ],
  inserts: {}
}

// ── Supabase stub ────────────────────────────────────────────
function builder(table) {
  const filters = []
  let single = false
  const b = {
    select: () => b, or: () => b, order: () => b, gt: () => b, ilike: () => b,
    limit: () => b, upsert: () => b, update: () => b,
    eq: (col, val) => { filters.push([col, val]); return b },
    insert: (row) => { (DB.inserts[table] = DB.inserts[table] || []).push(row); return b },
    single: () => { single = true; return b },
    then: (resolve) => {
      let rows = (DB[table] || []).filter(r => filters.every(([c, v]) => !(c in r) || r[c] === v))
      resolve({ data: single ? (rows[0] || null) : rows, error: null })
    }
  }
  return b
}
const supabaseStub = {
  from: (table) => builder(table),
  storage: { from: () => ({ upload: async () => ({ data: null, error: new Error('stub') }), getPublicUrl: () => ({ data: { publicUrl: null } }) }) }
}

// ── Module interception ──────────────────────────────────────
const stubs = {
  '@supabase/supabase-js': { createClient: () => supabaseStub },
  'twilio': Object.assign(() => ({ messages: { create: async () => ({ sid: 'SMstub' }) } }), {
    twiml: { MessagingResponse: class { message() {} toString() { return '<xml/>' } } }
  }),
  'africastalking': () => ({ SMS: { send: async (args) => { LOG.sms.push(args); return {} } } }),
  'axios': { post: async (url, payload) => { LOG.paystack.push(payload); return { data: { status: true, data: { status: 'pay_offline', display_text: '' } } } } },
  'pdfkit': class { on() {} rect() { return this } fill() { return this } end() {} },
  'nodemailer': { createTransport: () => ({ sendMail: async (m) => { LOG.email.push(m); return {} } }) },
  'dotenv': { config: () => {} },
  'express': Object.assign(() => {
    const app = { use: () => {}, post: () => {}, get: () => {}, listen: () => {} }
    return app
  }, { urlencoded: () => {}, json: () => {} })
}
const LOG = { sms: [], paystack: [], email: [] }
const origLoad = Module._load
Module._load = function (request, ...rest) {
  if (stubs[request]) return stubs[request]
  return origLoad.call(this, request, ...rest)
}

const { handleUSSD, handleMessage } = require('./server.js')

// ── Helpers ──────────────────────────────────────────────────
let failures = 0
function expect(label, text, ...needles) {
  const missing = needles.filter(s => !text.includes(s))
  if (missing.length) {
    failures++
    console.log(`FAIL  ${label}\n      missing: ${missing.map(m => JSON.stringify(m)).join(', ')}\n      got: ${JSON.stringify(text)}\n`)
  } else {
    console.log(`PASS  ${label}`)
  }
}

async function chat() {
  // Simulated WhatsApp/SMS conversation state
  let step = 'main_menu', data = {}
  const send = async (body, channel = 'sms') => {
    const r = await handleMessage({ current_step: step, session_data: data }, body, GUARDIAN_PHONE, channel)
    step = r.nextStep; data = r.sessionData || {}
    return r.text
  }
  return { send, getStep: () => step }
}

;(async () => {
  const mon = new Date().toLocaleDateString('en-GB', { month: 'long' })  // e.g. "June"

  // ════════ WhatsApp/SMS — English ════════
  let c = await chat()
  expect('EN main menu', await c.send('hi'), 'SchoolPay', '1. Pay Fees', '2. Check fee balance', '3. Academic results', '4. Badili lugha')
  expect('EN pay → child list', await c.send('1'), '1. Clarence Kioko Mueni - School XYZ', '2. Help', '* Back')
  expect('EN payment progress', await c.send('1'), 'Payment progress', '1. Lipa pole pole', '2. Pay all Term 2 fees')
  expect('EN pole pole amount', await c.send('1'), `${mon} balance Ksh 8,000`, '1. Pay full balance', 'or reply with amount, e.g Ksh 3,000')
  expect('EN custom amount → mpesa', await c.send('3000'), 'Enter M-Pesa number for payment')
  expect('EN confirmation', await c.send('0712345678'), 'Confirmation', 'STK push sent', 'Ksh 3,000', '* Home')

  // back navigation with '*'
  c = await chat()
  await c.send('hi'); await c.send('1'); await c.send('1')
  expect('EN full-term amount', await c.send('2'), 'Term 2 full balance Ksh 20,000')
  expect('EN pay full → mpesa', await c.send('1'), 'Enter M-Pesa number for payment')
  expect('EN * back → re-prompt amount', await c.send('*'), 'Pay full balance')

  // balance flow
  c = await chat()
  await c.send('hi'); await c.send('2')
  expect('EN balance screen', await c.send('1'), `${mon} balance Ksh 8,000`, 'Term 2 full balance Ksh 20,000', '1. Payment Statement')
  expect('EN statement shared', await c.send('1'), 'Payment Statement shared', 'Total paid: Ksh 6,500', '* Home')

  // results flow
  c = await chat()
  await c.send('hi'); await c.send('3')
  expect('EN results months', await c.send('1'), 'results ready', 'May/2026', 'June/2026', 'All', '* Back')
  expect('EN results shared', await c.send('1'), 'results shared', 'Maths', '* Home')

  // help (child listed)
  c = await chat()
  await c.send('hi'); await c.send('1')
  expect('EN help menu', await c.send('2'), '1. Clarence Kioko Mueni is not my child', '2. I have another child in this school')
  expect('EN help thanks', await c.send('1'), 'Thank you', 'school office', '* Home')

  // ════════ WhatsApp/SMS — Kiswahili ════════
  c = await chat()
  await c.send('hi')
  expect('SW main menu', await c.send('4'), '1. Lipa karo', '2. Karo idaiwayo', '3. Matokeo ya elimu', '4. Back to english')
  expect('SW child list', await c.send('1'), 'Clarence Kioko Mueni - School XYZ', '2. Msaada', '* Rudi')
  expect('SW payment progress', await c.send('1'), '1. Lipa pole pole', '2. Lipa salio lote la muhula wa pili')
  expect('SW amount', await c.send('1'), 'Salio la', '1. Lipa pesa yote', 'au andika malipo')
  expect('SW mpesa prompt', await c.send('1'), 'Andika nambari ya M-Pesa kwa ajili ya malipo')
  expect('SW confirmation', await c.send('0712345678'), 'Confirmation', 'PIN', '* Rudi mwanzo')

  c = await chat()
  await c.send('hi'); await c.send('4'); await c.send('2');
  expect('SW balance', await c.send('1'), 'Salio la', 'Muhula wa pili', '1. Risiti ya malipo')
  expect('SW statement', await c.send('1'), 'Risiti ya malipo imetumwa', '* Rudi mwanzo')

  // toggle back to english
  c = await chat()
  await c.send('hi'); await c.send('4')
  expect('SW → EN toggle', await c.send('4'), '1. Pay Fees')

  // ════════ USSD ════════
  const u = (text) => handleUSSD('sess-1', GUARDIAN_PHONE, text ? text.split('*') : [])
  expect('USSD EN menu', await u(''), 'CON SchoolPay', '1. Pay Fees', '4. Badili lugha')
  expect('USSD SW menu', await u('4'), '1. Lipa karo', '4. Back to english')
  expect('USSD child list', await u('1'), '1. Clarence Kioko Mueni - School XYZ', '2. Help')
  expect('USSD progress', await u('1*1'), 'Payment progress', '1. Lipa pole pole', '2. Pay all Term 2 fees')
  expect('USSD amount', await u('1*1*1'), `${mon} balance Ksh 8,000`, '1. Pay full balance', 'or enter amount')
  expect('USSD mpesa prompt', await u('1*1*1*1'), 'Enter M-Pesa number for payment')
  expect('USSD confirmation', await u('1*1*1*1*0712345678'), 'END SchoolPay', 'Confirmation', 'STK push sent', 'Ksh 8,000')
  expect('USSD custom amount', await u('1*1*2*3000*0712345678'), 'Ksh 3,000')
  expect('USSD balance', await u('2*1'), `${mon} balance Ksh 8,000`, 'Term 2 full balance Ksh 20,000', '1. Payment Statement')
  expect('USSD statement', await u('2*1*1'), 'Payment Statement shared via SMS', 'Total paid: Ksh 6,500')
  expect('USSD results months', await u('3*1'), 'results ready', 'May/2026', 'June/2026', 'All')
  expect('USSD results shared', await u('3*1*1'), 'results shared', 'Maths')
  expect('USSD help menu', await u('1*2'), 'is not my child', 'I have another child in this school')
  expect('USSD help thanks', await u('1*2*1'), 'END', 'school office')
  expect('USSD SW pay flow', await u('4*1*1*1'), 'Salio la', 'Lipa pesa yote')

  console.log(`\n${failures === 0 ? 'ALL FLOWS PASS' : failures + ' FAILURE(S)'}`)
  process.exit(failures ? 1 : 0)
})().catch(e => { console.error('SIM CRASH:', e); process.exit(1) })
