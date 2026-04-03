// ============================================================
// SCHOOLPAY WHATSAPP BOT - Fixed & Stable
// ============================================================
const express = require('express')
const { createClient } = require('@supabase/supabase-js')
const twilio = require('twilio')
const axios = require('axios')
const crypto = require('crypto')
require('dotenv').config()

const app = express()
app.use(express.urlencoded({ extended: true }))
app.use(express.json())

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})

// ── Clients ───────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
)
const MessagingResponse = twilio.twiml.MessagingResponse
const SCHOOL_ID = process.env.SCHOOL_ID
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY
const BOT_NUMBER = `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`

// ============================================================
// PHONE HELPERS
// ============================================================
function toPaystackPhone(raw) {
  // Paystack wants +254XXXXXXXXX (WITH + sign for Kenya)
  let n = raw.replace(/\D/g, '')
  if (n.startsWith('254')) n = n.slice(3)
  if (n.startsWith('0')) n = n.slice(1)
  return '+254' + n
}

function toWhatsappPhone(raw) {
  // Twilio wants +254XXXXXXXXX
  let n = raw.replace(/\D/g, '')
  if (n.startsWith('254')) n = n.slice(3)
  if (n.startsWith('0')) n = n.slice(1)
  return '+254' + n
}

function generateRef() {
  return `SCH-${Date.now()}-${Math.random().toString(36).substr(2,5).toUpperCase()}`
}

// ============================================================
// WHATSAPP WEBHOOK
// ============================================================
app.post('/webhook/whatsapp', async (req, res) => {
  // Always respond to Twilio immediately
  const twiml = new MessagingResponse()

  const from = req.body.From || ''
  const body = (req.body.Body || '').trim()
  const phone = from.replace('whatsapp:', '')

  let replyText = '❌ Error. Type *hi* to restart.'

  try {
    const session = await getSession(phone)
    const reply = await handleMessage(session, body, phone)
    await updateSession(phone, reply.nextStep, reply.sessionData || {})
    replyText = reply.text
  } catch (err) {
    console.error('Bot error:', err.message, err.stack)
  }

  twiml.message(replyText)
  res.set('Content-Type', 'text/xml')
  res.send(twiml.toString())
})

// ============================================================
// MESSAGE HANDLER
// ============================================================
async function handleMessage(session, body, phone) {
  const lower = body.toLowerCase().trim()
  const step = session.current_step || 'welcome'
  const data = session.session_data || {}

  // Reset keywords — always works
  if (['hi','hello','start','menu','0','back','restart'].includes(lower)) {
    await resetSession(phone)
    return welcome()
  }

  switch (step) {
    case 'welcome':         return welcome()
    case 'ask_email':       return askEmail(data, body)
    case 'ask_admission':   return askAdmission(data, body)
    case 'show_fees':       return showFees(data, body)
    case 'choose_method':   return chooseMethod(data, body)
    case 'ask_mpesa_phone': return doMpesa(data, body, phone)
    case 'card_number':     return cardNumber(data, body)
    case 'card_expiry':     return cardExpiry(data, body)
    case 'card_cvv':        return cardCvv(data, body, phone)
    default:
      return welcome()
  }
}

// ============================================================
// STEP HANDLERS
// ============================================================

function welcome() {
  return {
    text: `👋 *Welcome to SchoolPay!* 🏫\n\nPay school fees securely via WhatsApp.\n\nPlease enter your *email address* for your payment receipt:\n📧 _(e.g. parent@gmail.com)_`,
    nextStep: 'ask_email',
    sessionData: {}
  }
}

function askEmail(data, body) {
  const email = body.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return {
      text: `❌ Invalid email. Please enter a valid email address:\n_(e.g. parent@gmail.com)_`,
      nextStep: 'ask_email',
      sessionData: {}
    }
  }
  return {
    text: `✅ Email saved!\n\nNow enter the student's *Admission Number*:\n_(e.g. ADM/2025/001)_`,
    nextStep: 'ask_admission',
    sessionData: { email }
  }
}

async function askAdmission(data, body) {
  let student = null
  try {
    const { data: s } = await supabase
      .from('students')
      .select('*, classes(name, stream)')
      .eq('school_id', SCHOOL_ID)
      .ilike('admission_number', body.trim())
      .eq('is_active', true)
      .single()
    student = s
  } catch (e) { /* not found */ }

  if (!student) {
    return {
      text: `❌ Student *${body.trim()}* not found.\n\nCheck the admission number and try again.\nType *0* for menu.`,
      nextStep: 'ask_admission',
      sessionData: data
    }
  }

  const { data: allFees } = await supabase
    .from('v_student_fee_summary')
    .select('*')
    .eq('student_id', student.id)
    .order('fee_category')

  const outstanding = (allFees || []).filter(f => Number(f.balance) > 0)
  const cls = student.classes
    ? `${student.classes.name}${student.classes.stream ? ' ' + student.classes.stream : ''}`
    : 'N/A'

  if (!outstanding.length) {
    return {
      text: `✅ *All fees cleared!*\n\n👤 *${student.first_name} ${student.last_name}*\n🏫 ${cls}\n\nNo outstanding fees. Thank you! 🎉\n\nType *hi* to start again.`,
      nextStep: 'welcome',
      sessionData: {}
    }
  }

  const total = outstanding.reduce((s, f) => s + Number(f.balance), 0)
  let msg = `👤 *${student.first_name} ${student.last_name}*\n🏫 ${cls} | ${student.admission_number}\n\n📊 *Outstanding Fees:*\n`
  outstanding.forEach((f, i) => {
    msg += `\n*${i+1}.* ${f.fee_name} — *KES ${Number(f.balance).toLocaleString()}*`
  })
  msg += `\n\n💰 *Total: KES ${total.toLocaleString()}*`
  msg += `\n\n─────────────────`
  msg += `\nType a *number* to pay one fee`
  msg += `\nType *ALL* to pay everything`
  msg += `\nType *0* to go back`

  return {
    text: msg,
    nextStep: 'show_fees',
    sessionData: {
      email: data.email,
      student_id: student.id,
      student_name: `${student.first_name} ${student.last_name}`,
      guardian_name: student.guardian1_name || 'Guardian',
      fees: outstanding
    }
  }
}

function showFees(data, body) {
  const fees = data.fees || []
  if (!fees.length) return welcome()

  const input = body.trim().toUpperCase()
  let selected = []
  let total = 0
  let label = ''

  if (input === 'ALL') {
    selected = fees
    total = fees.reduce((s, f) => s + Number(f.balance), 0)
    label = 'All Outstanding Fees'
  } else {
    const idx = parseInt(body.trim()) - 1
    if (isNaN(idx) || idx < 0 || idx >= fees.length) {
      return {
        text: `❌ Invalid. Type *1 to ${fees.length}* or *ALL*.\nType *0* for menu.`,
        nextStep: 'show_fees',
        sessionData: data
      }
    }
    selected = [fees[idx]]
    total = Number(fees[idx].balance)
    label = fees[idx].fee_name
  }

  return {
    text: `💳 *Payment Summary*\n\n📋 ${label}\n💰 *KES ${total.toLocaleString()}*\n👤 ${data.student_name}\n\n─────────────────\n*Choose payment method:*\n\n*1.* 📱 M-Pesa STK Push\n*2.* 💳 Card (Visa/Mastercard)\n*3.* 🏦 Bank Transfer\n\nType *1*, *2*, or *3*`,
    nextStep: 'choose_method',
    sessionData: { ...data, selected_fees: selected, total_amount: total, fee_label: label }
  }
}

function chooseMethod(data, body) {
  const c = body.trim()
  if (!['1','2','3'].includes(c)) {
    return {
      text: `Type *1* M-Pesa, *2* Card, *3* Bank Transfer`,
      nextStep: 'choose_method',
      sessionData: data
    }
  }

  if (c === '1') {
    return {
      text: `📱 *M-Pesa Payment*\n\n💰 Amount: *KES ${Number(data.total_amount).toLocaleString()}*\n📋 ${data.fee_label}\n\nEnter the *M-Pesa phone number* to receive the STK push:\n\n📲 Format examples:\n• *0712345678*\n• *254712345678*\n• *+254712345678*\n\n_Type your M-Pesa number:_`,
      nextStep: 'ask_mpesa_phone',
      sessionData: data
    }
  }

  if (c === '2') {
    return {
      text: `💳 *Card Payment*\n\n💰 *KES ${Number(data.total_amount).toLocaleString()}*\n\n*Step 1 of 3*\nEnter your *16-digit card number*:\n_(No spaces — e.g. 4111111111111111)_\n🔒 Secured by Paystack`,
      nextStep: 'card_number',
      sessionData: data
    }
  }

  if (c === '3') {
    const ref = generateRef()
    savePending(data, ref, 'bank').catch(console.error)
    return {
      text: `🏦 *Bank Transfer*\n\n💰 *KES ${Number(data.total_amount).toLocaleString()}*\n📋 ${data.fee_label}\n👤 ${data.student_name}\n\n━━━━━━━━━━━━━━━━\n🏦 Bank: *Equity Bank*\n📝 Account: *0123456789*\n🏷️ Name: *Sunshine Academy*\n🔑 Ref: *${ref}*\n━━━━━━━━━━━━━━━━\n\nUse *${ref}* as reference.\nSend confirmation screenshot after transfer.\n\nType *0* for menu.`,
      nextStep: 'welcome',
      sessionData: {}
    }
  }
}

async function doMpesa(data, body, phone) {
  const raw = body.trim()
  const digits = raw.replace(/\D/g, '')

  if (digits.length < 9 || digits.length > 12) {
    return {
      text: `❌ Invalid number.\n\nEnter a valid M-Pesa number:\n• *0712345678* (10 digits)\n• *254712345678* (12 digits)\n\nTry again:`,
      nextStep: 'ask_mpesa_phone',
      sessionData: data
    }
  }

  const paystackPhone = toPaystackPhone(raw)
  const ref = generateRef()

  console.log(`[MPESA] Charging ${paystackPhone} KES ${data.total_amount} ref:${ref}`)

  try {
    const res = await axios.post(
      'https://api.paystack.co/charge',
      {
        email: data.email,
        amount: Math.round(Number(data.total_amount) * 100),
        currency: 'KES',
        reference: ref,
        mobile_money: {
          phone: paystackPhone,
          provider: 'mpesa'
        },
        metadata: {
          school_id: SCHOOL_ID,
          student_id: data.student_id,
          student_name: data.student_name,
          guardian_name: data.guardian_name,
          fee_label: data.fee_label,
          fee_ids: (data.selected_fees || []).map(f => f.student_fee_id).join(','),
          guardian_phone: phone,
          channel: 'whatsapp_mpesa'
        }
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
          'Content-Type': 'application/json'
        }
      }
    )

    const result = res.data
    console.log('[MPESA] Paystack response:', JSON.stringify(result))

    if (result.status === false) {
      throw new Error(result.message || 'Paystack rejected request')
    }

    const status = result.data?.status
    const displayText = result.data?.display_text || ''

    // Save pending payments
    await savePending(data, ref, 'mpesa')

    if (status === 'success') {
      await confirmAndUpdate(ref, data)
      return {
        text: `✅ *Payment Successful!*\n\n🎉 KES ${Number(data.total_amount).toLocaleString()} received!\n📧 Receipt sent to ${data.email}\n🙏 Thank you!\n\nType *hi* to check other fees.`,
        nextStep: 'welcome',
        sessionData: {}
      }
    }

    // pay_offline = STK push sent, waiting for PIN
    return {
      text: `📱 *STK Push Sent!*\n\n✅ Check phone *${paystackPhone}* now.\n\n👉 *Enter your M-Pesa PIN* on the popup.\n\n💰 *KES ${Number(data.total_amount).toLocaleString()}*\n📋 ${data.fee_label}\n🔑 Ref: ${ref}\n\n${displayText ? `_${displayText}_\n\n` : ''}⏳ *60 seconds* to enter PIN.\n\n_✅ You will receive automatic confirmation here once payment is complete. No action needed!_`,
      nextStep: 'welcome',
      sessionData: { waiting_ref: ref, guardian_phone: phone }
    }

  } catch (err) {
    const msg = err.response?.data?.message || err.message || 'Unknown error'
    console.error('[MPESA] Error:', msg, JSON.stringify(err.response?.data))

    return {
      text: `❌ *M-Pesa Failed*\n\n_${msg}_\n\n*Common fixes:*\n• Make sure M-Pesa is activated on the number\n• Try format: *0712345678*\n• Check Paystack dashboard has M-Pesa enabled\n\n*Type:*\n*1* → Retry M-Pesa\n*2* → Pay by card\n*0* → Main menu`,
      nextStep: 'choose_method',
      sessionData: data
    }
  }
}

function cardNumber(data, body) {
  const n = body.replace(/\s/g, '')
  if (!/^\d{16}$/.test(n)) {
    return {
      text: `❌ Invalid. Enter your *16-digit card number* (no spaces):`,
      nextStep: 'card_number',
      sessionData: data
    }
  }
  return {
    text: `✅ Card saved.\n\n*Step 2 of 3* — Enter *Expiry Date*:\n_(MM/YY — e.g. 12/26)_`,
    nextStep: 'card_expiry',
    sessionData: { ...data, card_number: n }
  }
}

function cardExpiry(data, body) {
  if (!/^\d{2}\/\d{2}$/.test(body.trim())) {
    return {
      text: `❌ Invalid. Enter expiry as *MM/YY*:\n_(e.g. 12/26)_`,
      nextStep: 'card_expiry',
      sessionData: data
    }
  }
  return {
    text: `✅ Expiry saved.\n\n*Step 3 of 3* — Enter your *CVV*:\n_(3-digit code on back of card)_`,
    nextStep: 'card_cvv',
    sessionData: { ...data, card_expiry: body.trim() }
  }
}

async function cardCvv(data, body, phone) {
  if (!/^\d{3,4}$/.test(body.trim())) {
    return {
      text: `❌ Invalid CVV. Enter the *3-digit* code on the back of your card:`,
      nextStep: 'card_cvv',
      sessionData: data
    }
  }

  const [expMonth, expYear] = data.card_expiry.split('/')
  const ref = generateRef()

  await sendWA(phone, `⏳ *Processing...*\n\n💰 KES ${Number(data.total_amount).toLocaleString()} — Please wait...`)

  try {
    const res = await axios.post(
      'https://api.paystack.co/charge',
      {
        email: data.email,
        amount: Math.round(Number(data.total_amount) * 100),
        reference: ref,
        currency: 'KES',
        card: {
          number: data.card_number,
          cvv: body.trim(),
          expiry_month: expMonth,
          expiry_year: '20' + expYear
        },
        metadata: {
          school_id: SCHOOL_ID,
          student_id: data.student_id,
          student_name: data.student_name,
          guardian_name: data.guardian_name,
          fee_label: data.fee_label,
          fee_ids: (data.selected_fees || []).map(f => f.student_fee_id).join(','),
          guardian_phone: phone,
          channel: 'whatsapp_card'
        }
      },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' } }
    )

    const status = res.data?.data?.status
    console.log('[CARD] Paystack response status:', status)

    await savePending(data, ref, 'card')

    if (status === 'success') {
      await confirmAndUpdate(ref, data)
      return {
        text: `✅ *Card Payment Successful!*\n\n🎉 Dear ${data.guardian_name}!\n\n👤 *${data.student_name}*\n💰 *KES ${Number(data.total_amount).toLocaleString()}*\n📋 ${data.fee_label}\n🔑 Ref: ${ref}\n\n📧 Receipt → ${data.email}\n🙏 Thank you!\n\nType *hi* to check other fees.`,
        nextStep: 'welcome',
        sessionData: {}
      }
    }

    return {
      text: `⏳ Payment processing...\nRef: *${ref}*\nYou will receive automatic confirmation here.\nType *0* for menu.`,
      nextStep: 'welcome',
      sessionData: {}
    }

  } catch (err) {
    const msg = err.response?.data?.message || 'Card declined'
    console.error('[CARD] Error:', msg)
    return {
      text: `❌ *Card Failed*\n\n_${msg}_\n\nType *2* retry card\nType *1* for M-Pesa\nType *0* menu`,
      nextStep: 'choose_method',
      sessionData: { ...data, card_number: undefined, card_expiry: undefined }
    }
  }
}

// ============================================================
// PAYSTACK WEBHOOK — Auto fires when M-Pesa PIN entered
// ============================================================
app.post('/webhook/paystack-confirm', async (req, res) => {
  try {
    const hash = crypto.createHmac('sha512', PAYSTACK_SECRET)
      .update(JSON.stringify(req.body)).digest('hex')
    if (hash !== req.headers['x-paystack-signature']) {
      return res.status(400).send('Bad signature')
    }

    const event = req.body
    console.log('[WEBHOOK]', event.event, event.data?.reference)

    if (event.event === 'charge.success') {
      const { reference, amount, metadata, customer } = event.data
      const paid = amount / 100

      // Update payments to success
      await supabase.from('payments')
        .update({ status: 'success', paystack_transaction_id: event.data.id, updated_at: new Date().toISOString() })
        .eq('paystack_reference', reference)

      // Update each fee balance
      const { data: pmts } = await supabase
        .from('payments').select('student_fee_id, amount').eq('paystack_reference', reference)

      for (const p of (pmts || [])) {
        if (!p.student_fee_id) continue
        const { data: sf } = await supabase.from('student_fees').select('*').eq('id', p.student_fee_id).single()
        if (!sf) continue
        const newPaid = Number(sf.amount_paid) + Number(p.amount)
        await supabase.from('student_fees').update({
          amount_paid: newPaid,
          status: newPaid >= Number(sf.amount_due) ? 'paid' : 'partial',
          updated_at: new Date().toISOString()
        }).eq('id', p.student_fee_id)
      }

      // Auto WhatsApp confirmation to guardian
      const rawPhone = metadata?.guardian_phone
      if (rawPhone) {
        const wa = toWhatsappPhone(rawPhone)
        console.log('[WEBHOOK] Sending confirmation to:', wa)
        await sendWA(wa,
          `✅ *Payment Confirmed!*\n\n🎉 Dear ${metadata?.guardian_name || 'Guardian'},\n\n👤 Student: *${metadata?.student_name}*\n💰 Amount: *KES ${paid.toLocaleString()}*\n📋 Fee: *${metadata?.fee_label || 'School Fees'}*\n🔑 Ref: *${reference}*\n\n📧 Receipt → *${customer.email}*\n\n🙏 Thank you for investing in your child's education!\n\nType *hi* to check remaining fees.`
        )
      }
    }
  } catch (err) {
    console.error('[WEBHOOK] Error:', err.message)
  }

  res.sendStatus(200)
})

// ============================================================
// DASHBOARD API — Send reminder to one student's guardian
// ============================================================
app.post('/api/send-reminder', async (req, res) => {
  const { student_id } = req.body
  if (!student_id) return res.status(400).json({ error: 'student_id required' })

  try {
    const { data: student } = await supabase
      .from('students')
      .select('*, classes(name, stream)')
      .eq('id', student_id)
      .single()

    if (!student) return res.status(404).json({ error: 'Student not found' })

    const { data: fees } = await supabase
      .from('v_student_fee_summary')
      .select('*')
      .eq('student_id', student_id)
      .gt('balance', 0)

    if (!fees || fees.length === 0) {
      return res.json({ success: true, message: 'No outstanding fees' })
    }

    const total = fees.reduce((s, f) => s + Number(f.balance), 0)
    const lines = fees.map(f => `• ${f.fee_name}: KES ${Number(f.balance).toLocaleString()}`).join('\n')
    const cls = student.classes
      ? `${student.classes.name}${student.classes.stream ? ' ' + student.classes.stream : ''}`
      : ''

    // Priority: guardian1_whatsapp → guardian1_phone
    const rawPhone = student.guardian1_whatsapp || student.guardian1_phone
    if (!rawPhone) return res.status(400).json({ error: 'No phone number for guardian' })

    const wa = toWhatsappPhone(rawPhone)
    console.log(`[REMINDER] ${student.first_name} ${student.last_name} → ${wa}`)

    await sendWA(wa,
      `🔔 *Payment Reminder*\n\nDear *${student.guardian1_name}*,\n\nOutstanding fees for *${student.first_name} ${student.last_name}* (${cls}):\n\n${lines}\n\n💰 *Total: KES ${total.toLocaleString()}*\n\nTo pay, WhatsApp us and type *hi* 😊\n\nThank you! 🙏`
    )

    res.json({ success: true, sent_to: wa, student: `${student.first_name} ${student.last_name}`, total })
  } catch (err) {
    console.error('[REMINDER] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// DASHBOARD API — Bulk reminders to all guardians
// ============================================================
app.post('/api/send-reminders', async (req, res) => {
  try {
    const { data: allFees } = await supabase
      .from('v_student_fee_summary').select('*').gt('balance', 0)

    const byStudent = {}
    ;(allFees || []).forEach(f => {
      if (!byStudent[f.student_id]) byStudent[f.student_id] = { name: f.full_name, fees: [] }
      byStudent[f.student_id].fees.push(f)
    })

    let sent = 0, skipped = 0
    for (const [sid, sd] of Object.entries(byStudent)) {
      const { data: s } = await supabase
        .from('students')
        .select('guardian1_whatsapp, guardian1_phone, guardian1_name')
        .eq('id', sid).single()

      const raw = s?.guardian1_whatsapp || s?.guardian1_phone
      if (!raw) { skipped++; continue }

      const wa = toWhatsappPhone(raw)
      const lines = sd.fees.map(f => `• ${f.fee_name}: KES ${Number(f.balance).toLocaleString()}`).join('\n')
      const total = sd.fees.reduce((s, f) => s + Number(f.balance), 0)

      await sendWA(wa,
        `🔔 *Payment Reminder*\n\nDear *${s.guardian1_name}*,\n\nOutstanding fees for *${sd.name}*:\n\n${lines}\n\n💰 *Total: KES ${total.toLocaleString()}*\n\nType *hi* here to pay now 😊\n\n🙏 Thank you!`
      )
      sent++
      await new Promise(r => setTimeout(r, 700))
    }

    res.json({ success: true, reminders_sent: sent, skipped })
  } catch (err) {
    console.error('[BULK] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// HELPERS
// ============================================================
async function savePending(data, ref, method) {
  for (const fee of (data.selected_fees || [])) {
    try {
      await supabase.from('payments').insert({
        school_id: SCHOOL_ID,
        student_id: data.student_id,
        student_fee_id: fee.student_fee_id,
        amount: Number(fee.balance),
        payment_method: method,
        paystack_reference: ref,
        paid_by_email: data.email,
        paid_by_name: data.guardian_name || 'Guardian',
        status: 'pending'
      })
    } catch (e) {
      console.error('savePending error:', e.message)
    }
  }
}

async function confirmAndUpdate(ref, data) {
  await supabase.from('payments')
    .update({ status: 'success', updated_at: new Date().toISOString() })
    .eq('paystack_reference', ref)

  for (const fee of (data.selected_fees || [])) {
    const { data: sf } = await supabase.from('student_fees').select('*').eq('id', fee.student_fee_id).single()
    if (!sf) continue
    const newPaid = Number(sf.amount_paid) + Number(fee.balance)
    await supabase.from('student_fees').update({
      amount_paid: newPaid,
      status: newPaid >= Number(sf.amount_due) ? 'paid' : 'partial',
      updated_at: new Date().toISOString()
    }).eq('id', fee.student_fee_id)
  }
}

async function sendWA(phone, message) {
  try {
    const to = `whatsapp:${toWhatsappPhone(phone)}`
    console.log(`[WA] Sending to ${to}`)
    const r = await twilioClient.messages.create({ from: BOT_NUMBER, to, body: message })
    console.log(`[WA] ✅ Sent SID: ${r.sid}`)
  } catch (err) {
    console.error(`[WA] ❌ Failed to ${phone}:`, err.message)
  }
}

async function getSession(phone) {
  try {
    const { data } = await supabase
      .from('whatsapp_sessions').select('*').eq('phone_number', phone).single()

    if (!data) {
      const { data: s } = await supabase
        .from('whatsapp_sessions')
        .insert({ phone_number: phone, current_step: 'welcome', session_data: {} })
        .select().single()
      return s || { phone_number: phone, current_step: 'welcome', session_data: {} }
    }

    // Expire after 30 min inactivity
    if (data.last_activity && (Date.now() - new Date(data.last_activity)) > 30 * 60 * 1000) {
      await supabase.from('whatsapp_sessions')
        .update({ current_step: 'welcome', session_data: {}, last_activity: new Date() })
        .eq('phone_number', phone)
      return { ...data, current_step: 'welcome', session_data: {} }
    }

    return data
  } catch (err) {
    console.error('getSession error:', err.message)
    return { phone_number: phone, current_step: 'welcome', session_data: {} }
  }
}

async function updateSession(phone, step, sessionData) {
  try {
    await supabase.from('whatsapp_sessions').upsert(
      { phone_number: phone, current_step: step, session_data: sessionData, last_activity: new Date().toISOString() },
      { onConflict: 'phone_number' }
    )
  } catch (err) {
    console.error('updateSession error:', err.message)
  }
}

async function resetSession(phone) {
  try {
    await supabase.from('whatsapp_sessions').upsert(
      { phone_number: phone, current_step: 'welcome', session_data: {}, last_activity: new Date().toISOString() },
      { onConflict: 'phone_number' }
    )
  } catch (err) {
    console.error('resetSession error:', err.message)
  }
}

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'SchoolPay Bot', time: new Date().toISOString() }))

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`🚀 SchoolPay Bot running on port ${PORT}`))
