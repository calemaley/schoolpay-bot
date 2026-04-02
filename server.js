// ============================================================
// SCHOOLPAY WHATSAPP BOT - Clean Rewrite
// M-Pesa: asks for phone number → STK push → auto confirm
// Reminders: sends to guardian WhatsApp in +254 format
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

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
const MessagingResponse = twilio.twiml.MessagingResponse
const SCHOOL_ID = process.env.SCHOOL_ID
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY
const BOT_NUMBER = `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`

// ============================================================
// PHONE NORMALIZERS
// ============================================================
// For Paystack M-Pesa: needs 254XXXXXXXXX (no + sign)
function toPaystackPhone(phone) {
  let n = phone.replace(/\D/g, '') // strip all non-digits
  if (n.startsWith('254')) return n
  if (n.startsWith('0')) return '254' + n.slice(1)
  if (n.length === 9) return '254' + n
  return n
}

// For WhatsApp sending: needs +254XXXXXXXXX
function toWhatsAppPhone(phone) {
  let n = phone.replace(/\D/g, '')
  if (n.startsWith('254')) return '+' + n
  if (n.startsWith('0')) return '+254' + n.slice(1)
  if (n.length === 9) return '+254' + n
  if (n.startsWith('+')) return phone.replace(/\s/g, '')
  return '+' + n
}

// ============================================================
// WHATSAPP WEBHOOK
// ============================================================
app.post('/webhook/whatsapp', async (req, res) => {
  const from = req.body.From // whatsapp:+254XXXXXXXXX
  const body = (req.body.Body || '').trim()
  const phone = from.replace('whatsapp:', '') // +254XXXXXXXXX

  try {
    const session = await getSession(phone)
    const reply = await processMessage(session, body, phone)
    await updateSession(phone, reply.nextStep, reply.sessionData || {})

    const twiml = new MessagingResponse()
    twiml.message(reply.text)
    res.set('Content-Type', 'text/xml')
    res.send(twiml.toString())
  } catch (err) {
    console.error('Webhook error:', err)
    const twiml = new MessagingResponse()
    twiml.message('❌ Error occurred. Type *hi* to restart.')
    res.set('Content-Type', 'text/xml')
    res.send(twiml.toString())
  }
})

// ============================================================
// MAIN MESSAGE ROUTER
// ============================================================
async function processMessage(session, body, phone) {
  const lower = body.toLowerCase().trim()
  const restartWords = ['hi', 'hello', 'start', 'menu', 'restart', '0', 'back']

  if (restartWords.includes(lower)) {
    await resetSession(phone)
    return stepWelcome()
  }

  const step = session.current_step
  const data = session.session_data || {}

  console.log(`[${phone}] step=${step} body=${body}`)

  switch (step) {
    case 'welcome':        return stepWelcome()
    case 'ask_email':      return stepEmail(data, body)
    case 'ask_admission':  return stepAdmission(data, body)
    case 'show_fees':      return stepFeeSelect(data, body)
    case 'choose_method':  return stepChooseMethod(data, body)
    case 'ask_mpesa_phone': return stepMpesaPhone(data, body)
    case 'card_number':    return stepCardNumber(data, body)
    case 'card_expiry':    return stepCardExpiry(data, body)
    case 'card_cvv':       return stepCardCvv(data, body, phone)
    default:               return stepWelcome()
  }
}

// ============================================================
// STEP: WELCOME
// ============================================================
function stepWelcome() {
  return {
    text: `👋 *Welcome to SchoolPay!* 🏫\n\nSecure school fees payment system.\n\nPlease enter your *email address* to receive a payment receipt:\n\n📧 _(e.g. parent@gmail.com)_`,
    nextStep: 'ask_email',
    sessionData: {}
  }
}

// ============================================================
// STEP: EMAIL
// ============================================================
function stepEmail(data, body) {
  const email = body.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return {
      text: `❌ Invalid email address.\n\nPlease enter a valid email:\n_(e.g. parent@gmail.com)_`,
      nextStep: 'ask_email',
      sessionData: data
    }
  }
  return {
    text: `✅ Email saved!\n\nNow enter the student's *Admission Number*:\n_(e.g. ADM/2025/001)_`,
    nextStep: 'ask_admission',
    sessionData: { email }
  }
}

// ============================================================
// STEP: ADMISSION NUMBER
// ============================================================
async function stepAdmission(data, body) {
  const { data: student } = await supabase
    .from('students')
    .select('*, classes(name, stream)')
    .eq('school_id', SCHOOL_ID)
    .ilike('admission_number', body.trim())
    .eq('is_active', true)
    .single()

  if (!student) {
    return {
      text: `❌ No student found with admission number *${body.trim()}*.\n\nCheck the number and try again.\nType *0* for menu.`,
      nextStep: 'ask_admission',
      sessionData: data
    }
  }

  // Load outstanding fees
  const { data: allFees } = await supabase
    .from('v_student_fee_summary')
    .select('*')
    .eq('student_id', student.id)
    .order('fee_category')

  const outstanding = (allFees || []).filter(f => Number(f.balance) > 0)
  const className = student.classes
    ? `${student.classes.name}${student.classes.stream ? ' ' + student.classes.stream : ''}`
    : 'N/A'

  if (outstanding.length === 0) {
    return {
      text: `✅ *All fees cleared!*\n\n👤 *${student.first_name} ${student.last_name}*\n🏫 ${className}\n\nNo outstanding fees. Thank you! 🎉\n\nType *hi* to start again.`,
      nextStep: 'welcome',
      sessionData: {}
    }
  }

  const total = outstanding.reduce((s, f) => s + Number(f.balance), 0)

  let msg = `👤 *${student.first_name} ${student.last_name}*\n🏫 ${className} | ${student.admission_number}\n\n*📊 Outstanding Fees:*\n`
  outstanding.forEach((f, i) => {
    msg += `\n*${i + 1}.* ${f.fee_name}\n    Balance: *KES ${Number(f.balance).toLocaleString()}*`
  })
  msg += `\n\n💰 *Total: KES ${total.toLocaleString()}*`
  msg += `\n\n─────────────────`
  msg += `\nType a *number* to pay one fee`
  msg += `\nType *ALL* to pay everything at once`
  msg += `\nType *0* to go back`

  // IMPORTANT: store fees directly in session so they never get lost
  return {
    text: msg,
    nextStep: 'show_fees',
    sessionData: {
      email: data.email,
      student_id: student.id,
      student_name: `${student.first_name} ${student.last_name}`,
      guardian_name: student.guardian1_name || 'Guardian',
      fees: outstanding  // stored here — available in all next steps
    }
  }
}

// ============================================================
// STEP: SELECT WHICH FEE(S) TO PAY
// ============================================================
function stepFeeSelect(data, body) {
  const fees = data.fees || []

  if (!fees.length) {
    return {
      text: `❌ Session expired. Type *hi* to start again.`,
      nextStep: 'welcome',
      sessionData: {}
    }
  }

  const input = body.trim().toUpperCase()
  let selectedFees = []
  let totalAmount = 0
  let feeLabel = ''

  if (input === 'ALL') {
    selectedFees = fees
    totalAmount = fees.reduce((s, f) => s + Number(f.balance), 0)
    feeLabel = 'All Outstanding Fees'
  } else {
    const idx = parseInt(body.trim()) - 1
    if (isNaN(idx) || idx < 0 || idx >= fees.length) {
      return {
        text: `❌ Invalid. Type a number *1 to ${fees.length}* or type *ALL*.\nType *0* for menu.`,
        nextStep: 'show_fees',
        sessionData: data
      }
    }
    selectedFees = [fees[idx]]
    totalAmount = Number(fees[idx].balance)
    feeLabel = fees[idx].fee_name
  }

  return {
    text: `💳 *Payment Summary*\n\n📋 ${feeLabel}\n💰 *KES ${totalAmount.toLocaleString()}*\n👤 ${data.student_name}\n\n─────────────────\n*Choose payment method:*\n\n*1.* 📱 M-Pesa\n*2.* 💳 Card (Visa/Mastercard)\n*3.* 🏦 Bank Transfer\n\nType *1*, *2*, or *3*`,
    nextStep: 'choose_method',
    sessionData: {
      ...data,
      selected_fees: selectedFees,
      total_amount: totalAmount,
      fee_label: feeLabel
    }
  }
}

// ============================================================
// STEP: CHOOSE PAYMENT METHOD
// ============================================================
function stepChooseMethod(data, body) {
  const choice = body.trim()

  if (!['1', '2', '3'].includes(choice)) {
    return {
      text: `Type *1* for M-Pesa, *2* for Card, *3* for Bank Transfer`,
      nextStep: 'choose_method',
      sessionData: data
    }
  }

  if (choice === '1') {
    return {
      text: `📱 *M-Pesa Payment*\n\n💰 Amount: *KES ${Number(data.total_amount).toLocaleString()}*\n📋 Fee: *${data.fee_label}*\n\nEnter the *M-Pesa phone number* to send the STK push to:\n_(Format: 0712345678 or 254712345678)_\n\n💡 _Example: 0712345678_`,
      nextStep: 'ask_mpesa_phone',
      sessionData: data
    }
  }

  if (choice === '2') {
    return {
      text: `💳 *Card Payment*\n\n💰 Amount: *KES ${Number(data.total_amount).toLocaleString()}*\n\n*Step 1 of 3* — Enter your *16-digit card number*:\n_(No spaces — e.g. 4111111111111111)_\n\n🔒 _Secured by Paystack_`,
      nextStep: 'card_number',
      sessionData: data
    }
  }

  if (choice === '3') {
    const ref = generateRef()
    // Save bank transfer as pending
    savePendingPayments(data.selected_fees, data, ref, 'bank')
    return {
      text: `🏦 *Bank Transfer Details*\n\n💰 *KES ${Number(data.total_amount).toLocaleString()}*\n📋 ${data.fee_label}\n👤 ${data.student_name}\n\n━━━━━━━━━━━━━━━━━━\n🏦 Bank: *Equity Bank*\n📝 Account: *0123456789*\n🏷️ Name: *Sunshine Academy*\n🔑 Reference: *${ref}*\n━━━━━━━━━━━━━━━━━━\n\n⚠️ Use *${ref}* as reference when transferring.\n\nAfter transfer, send us the confirmation screenshot. We'll verify and update manually.\n\nType *0* for menu.`,
      nextStep: 'welcome',
      sessionData: {}
    }
  }
}

// ============================================================
// STEP: ASK M-PESA PHONE NUMBER → SEND STK PUSH
// ============================================================
async function stepMpesaPhone(data, body) {
  const rawPhone = body.trim()

  // Validate — must be 10 digits (07...) or 12 digits (254...)
  const digitsOnly = rawPhone.replace(/\D/g, '')
  if (digitsOnly.length < 9 || digitsOnly.length > 12) {
    return {
      text: `❌ Invalid phone number.\n\nPlease enter a valid M-Pesa number:\n_(e.g. 0712345678 or 254712345678)_`,
      nextStep: 'ask_mpesa_phone',
      sessionData: data
    }
  }

  const paystackPhone = toPaystackPhone(rawPhone) // 254XXXXXXXXX
  const ref = generateRef()

  console.log(`M-Pesa STK push → ${paystackPhone}, amount: ${data.total_amount}, ref: ${ref}`)

  try {
    // Use /charge with mobile_money — sends STK push immediately
    const response = await axios.post(
      'https://api.paystack.co/charge',
      {
        email: data.email,
        amount: Math.round(Number(data.total_amount) * 100), // in cents
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
          guardian_phone: body.trim(), // original number typed by parent
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

    const result = response.data
    console.log('Paystack M-Pesa response:', JSON.stringify(result))

    if (!result.status) {
      throw new Error(result.message || 'Paystack rejected the request')
    }

    // Save pending payment records in DB
    await savePendingPayments(data.selected_fees, data, ref, 'mpesa')

    const chargeStatus = result.data?.status

    if (chargeStatus === 'success') {
      // Immediately paid — update dashboard now
      await confirmAndUpdateDashboard(ref, data.selected_fees, data)
      return {
        text: `✅ *Payment Successful!*\n\n🎉 KES ${Number(data.total_amount).toLocaleString()} received!\n\nReceipt sent to *${data.email}* 📧\n\nThank you! 🙏\n\nType *hi* to check other fees.`,
        nextStep: 'welcome',
        sessionData: {}
      }
    }

    // STK push sent — waiting for PIN entry
    return {
      text: `📱 *STK Push Sent!*\n\n✅ Check phone *+${paystackPhone.slice(3)}* now!\n\n👉 *Enter your M-Pesa PIN* on the popup that appeared.\n\n💰 Amount: *KES ${Number(data.total_amount).toLocaleString()}*\n📋 Fee: *${data.fee_label}*\n🔑 Ref: *${ref}*\n\n⏳ You have *60 seconds* to enter your PIN.\n\n_✅ You will receive an automatic confirmation here the moment payment is complete. No further action needed!_`,
      nextStep: 'welcome',
      sessionData: { guardian_phone_raw: body.trim() }
    }

  } catch (err) {
    const errMsg = err.response?.data?.message || err.message || 'Unknown error'
    console.error('M-Pesa STK error:', errMsg, JSON.stringify(err.response?.data))
    return {
      text: `❌ *M-Pesa Failed*\n\n_${errMsg}_\n\nCommon fixes:\n• Enter number in format: *0712345678*\n• Make sure number is M-Pesa registered\n• Check you have enough balance\n\nType *1* to retry M-Pesa\nType *2* for card payment\nType *0* for menu`,
      nextStep: 'choose_method',
      sessionData: data
    }
  }
}

// ============================================================
// CARD PAYMENT STEPS
// ============================================================
function stepCardNumber(data, body) {
  const cardNum = body.replace(/\s/g, '')
  if (!/^\d{16}$/.test(cardNum)) {
    return {
      text: `❌ Invalid. Enter your *16-digit card number* (no spaces):`,
      nextStep: 'card_number',
      sessionData: data
    }
  }
  return {
    text: `✅ Card received.\n\n*Step 2 of 3* — Enter *Expiry Date*:\n_(Format: MM/YY — e.g. 12/26)_`,
    nextStep: 'card_expiry',
    sessionData: { ...data, card_number: cardNum }
  }
}

function stepCardExpiry(data, body) {
  if (!/^\d{2}\/\d{2}$/.test(body.trim())) {
    return {
      text: `❌ Invalid format. Enter expiry as *MM/YY*:\n_(e.g. 12/26)_`,
      nextStep: 'card_expiry',
      sessionData: data
    }
  }
  return {
    text: `✅ Expiry received.\n\n*Step 3 of 3* — Enter your *CVV*:\n_(3-digit code on back of card)_`,
    nextStep: 'card_cvv',
    sessionData: { ...data, card_expiry: body.trim() }
  }
}

async function stepCardCvv(data, body, phone) {
  if (!/^\d{3,4}$/.test(body.trim())) {
    return {
      text: `❌ Invalid CVV. Enter the *3-digit code* on the back of your card:`,
      nextStep: 'card_cvv',
      sessionData: data
    }
  }

  const [expMonth, expYear] = data.card_expiry.split('/')
  const ref = generateRef()

  // Send immediate "processing" message
  await sendWhatsApp(phone, `⏳ *Processing card payment...*\n\n💰 KES ${Number(data.total_amount).toLocaleString()} — Please wait a moment...`)

  try {
    const response = await axios.post(
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

    const chargeData = response.data.data
    const status = chargeData?.status

    if (status === 'success') {
      await confirmAndUpdateDashboard(ref, data.selected_fees, data)
      return {
        text: `✅ *Card Payment Successful!*\n\n🎉 Dear ${data.guardian_name}!\n\n👤 *${data.student_name}*\n💰 *KES ${Number(data.total_amount).toLocaleString()}*\n📋 ${data.fee_label}\n🔑 Ref: *${ref}*\n\n📧 Receipt sent to *${data.email}*\n\n🙏 Thank you!\n\nType *hi* to check other fees.`,
        nextStep: 'welcome',
        sessionData: {}
      }
    } else {
      return {
        text: `⏳ Payment is being verified. Ref: *${ref}*\n\nYou will get a confirmation here automatically.\nType *0* for menu.`,
        nextStep: 'welcome',
        sessionData: {}
      }
    }
  } catch (err) {
    const errMsg = err.response?.data?.message || 'Card declined'
    console.error('Card error:', errMsg)
    return {
      text: `❌ *Card Failed*\n\n_${errMsg}_\n\nType *2* to retry card\nType *1* for M-Pesa\nType *0* for menu`,
      nextStep: 'choose_method',
      sessionData: { ...data, card_number: undefined, card_expiry: undefined }
    }
  }
}

// ============================================================
// PAYSTACK WEBHOOK — Auto fires when M-Pesa PIN entered
// ============================================================
app.post('/webhook/paystack-confirm', async (req, res) => {
  const hash = crypto.createHmac('sha512', PAYSTACK_SECRET)
    .update(JSON.stringify(req.body)).digest('hex')
  if (hash !== req.headers['x-paystack-signature']) {
    return res.status(400).send('Bad signature')
  }

  const event = req.body
  console.log('Paystack event:', event.event, event.data?.reference)

  if (event.event === 'charge.success') {
    const { reference, amount, metadata, customer } = event.data
    const amountPaid = amount / 100

    try {
      // Mark all matching payments as success
      await supabase.from('payments')
        .update({
          status: 'success',
          paystack_transaction_id: event.data.id,
          mpesa_receipt: event.data.authorization?.sender_mobile_money_number,
          updated_at: new Date().toISOString()
        })
        .eq('paystack_reference', reference)

      // Update student fee balances — dashboard reflects immediately
      const { data: payments } = await supabase
        .from('payments').select('student_fee_id, amount').eq('paystack_reference', reference)

      for (const p of (payments || [])) {
        if (!p.student_fee_id) continue
        const { data: sf } = await supabase.from('student_fees').select('*').eq('id', p.student_fee_id).single()
        if (sf) {
          const newPaid = Number(sf.amount_paid) + Number(p.amount)
          await supabase.from('student_fees').update({
            amount_paid: newPaid,
            status: newPaid >= Number(sf.amount_due) ? 'paid' : 'partial',
            updated_at: new Date().toISOString()
          }).eq('id', p.student_fee_id)
        }
      }

      // Send automatic WhatsApp confirmation
      const guardianRawPhone = metadata?.guardian_phone
      if (guardianRawPhone) {
        const guardianWA = toWhatsAppPhone(guardianRawPhone)
        console.log(`Sending confirmation to guardian: ${guardianWA}`)

        await sendWhatsApp(
          guardianWA,
          `✅ *Payment Confirmed!*\n\n🎉 Dear ${metadata?.guardian_name || 'Guardian'}, your payment was received!\n\n👤 Student: *${metadata?.student_name}*\n💰 Amount: *KES ${amountPaid.toLocaleString()}*\n📋 Fee: *${metadata?.fee_label || 'School Fees'}*\n🔑 Ref: *${reference}*\n\n📧 Receipt sent to *${customer.email}*\n\n🙏 Thank you!\n\nType *hi* to check remaining fees.`
        )
      }

      console.log(`✅ Payment confirmed: ${reference} — KES ${amountPaid}`)
    } catch (err) {
      console.error('Webhook error:', err.message)
    }
  }

  res.sendStatus(200)
})

// ============================================================
// SEND SINGLE REMINDER (called by dashboard)
// Sends to guardian WhatsApp number stored in student form
// ============================================================
app.post('/api/send-reminder', async (req, res) => {
  const { student_id } = req.body
  if (!student_id) return res.status(400).json({ error: 'student_id required' })

  try {
    const { data: student, error } = await supabase
      .from('students')
      .select('*, classes(name, stream)')
      .eq('id', student_id)
      .single()

    if (error || !student) {
      return res.status(404).json({ error: 'Student not found' })
    }

    const { data: fees } = await supabase
      .from('v_student_fee_summary')
      .select('*')
      .eq('student_id', student_id)
      .gt('balance', 0)

    if (!fees || fees.length === 0) {
      return res.json({ success: true, message: 'No outstanding fees for this student' })
    }

    const total = fees.reduce((s, f) => s + Number(f.balance), 0)
    const feeLines = fees.map(f => `• ${f.fee_name}: KES ${Number(f.balance).toLocaleString()}`).join('\n')
    const className = student.classes
      ? `${student.classes.name}${student.classes.stream ? ' ' + student.classes.stream : ''}`
      : ''

    // Use guardian1_whatsapp if available, otherwise guardian1_phone
    // Both will be normalized to +254 format
    const rawPhone = student.guardian1_whatsapp || student.guardian1_phone

    if (!rawPhone) {
      return res.status(400).json({ error: 'No phone number found for this guardian' })
    }

    // Normalize to +254XXXXXXXXX format
    const guardianWhatsApp = toWhatsAppPhone(rawPhone)
    console.log(`Sending reminder: ${student.first_name} ${student.last_name} → ${guardianWhatsApp}`)

    await sendWhatsApp(
      guardianWhatsApp,
      `🔔 *Friendly Payment Reminder*\n\nDear *${student.guardian1_name}*,\n\nThe following fees are outstanding for *${student.first_name} ${student.last_name}* (${className}):\n\n${feeLines}\n\n💰 *Total Due: KES ${total.toLocaleString()}*\n\nTo pay, message this WhatsApp and type *hi* 😊\n\nThank you for your support! 🙏`
    )

    res.json({
      success: true,
      message: 'Reminder sent',
      sent_to: guardianWhatsApp,
      student: `${student.first_name} ${student.last_name}`,
      outstanding_balance: total
    })
  } catch (err) {
    console.error('send-reminder error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// SEND BULK REMINDERS (dashboard — all students with balances)
// ============================================================
app.post('/api/send-reminders', async (req, res) => {
  try {
    const { data: allFees } = await supabase
      .from('v_student_fee_summary')
      .select('*')
      .gt('balance', 0)

    // Group fees by student
    const byStudent = {}
    ;(allFees || []).forEach(row => {
      if (!byStudent[row.student_id]) {
        byStudent[row.student_id] = { name: row.full_name, fees: [] }
      }
      byStudent[row.student_id].fees.push(row)
    })

    let sent = 0
    let failed = 0

    for (const [studentId, studentData] of Object.entries(byStudent)) {
      const { data: student } = await supabase
        .from('students')
        .select('guardian1_whatsapp, guardian1_phone, guardian1_name, first_name, last_name')
        .eq('id', studentId)
        .single()

      const rawPhone = student?.guardian1_whatsapp || student?.guardian1_phone
      if (!rawPhone) { failed++; continue }

      const guardianWhatsApp = toWhatsAppPhone(rawPhone)
      const feeLines = studentData.fees
        .map(f => `• ${f.fee_name}: KES ${Number(f.balance).toLocaleString()}`).join('\n')
      const total = studentData.fees.reduce((s, f) => s + Number(f.balance), 0)

      console.log(`Bulk reminder → ${guardianWhatsApp} for ${studentData.name}`)

      await sendWhatsApp(
        guardianWhatsApp,
        `🔔 *Payment Reminder*\n\nDear *${student.guardian1_name}*,\n\nOutstanding fees for *${studentData.name}*:\n\n${feeLines}\n\n💰 *Total: KES ${total.toLocaleString()}*\n\nType *hi* here to pay now — takes 2 minutes! 😊\n\n🙏 Thank you!`
      )

      sent++
      await new Promise(r => setTimeout(r, 700)) // avoid rate limiting
    }

    res.json({ success: true, reminders_sent: sent, failed })
  } catch (err) {
    console.error('bulk reminders error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// HELPERS
// ============================================================
async function savePendingPayments(selectedFees, data, ref, method) {
  for (const fee of (selectedFees || [])) {
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
    }).select()
  }
}

async function confirmAndUpdateDashboard(ref, selectedFees, data) {
  // Update payments to success
  await supabase.from('payments')
    .update({ status: 'success', updated_at: new Date().toISOString() })
    .eq('paystack_reference', ref)

  // Update student fee balances
  for (const fee of (selectedFees || [])) {
    const { data: sf } = await supabase
      .from('student_fees').select('*').eq('id', fee.student_fee_id).single()
    if (sf) {
      const newPaid = Number(sf.amount_paid) + Number(fee.balance)
      await supabase.from('student_fees').update({
        amount_paid: newPaid,
        status: newPaid >= Number(sf.amount_due) ? 'paid' : 'partial',
        updated_at: new Date().toISOString()
      }).eq('id', fee.student_fee_id)
    }
  }
}

function generateRef() {
  return `SCH-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`
}

async function sendWhatsApp(phone, message) {
  try {
    // Always use +254XXXXXXXXX format for Twilio
    const normalized = toWhatsAppPhone(phone)
    console.log(`Sending WhatsApp → whatsapp:${normalized}`)
    const result = await twilioClient.messages.create({
      from: BOT_NUMBER,
      to: `whatsapp:${normalized}`,
      body: message
    })
    console.log(`✅ WhatsApp sent to ${normalized} — SID: ${result.sid}`)
  } catch (err) {
    console.error(`❌ WhatsApp failed to ${phone}:`, err.message)
  }
}

async function getSession(phone) {
  const { data } = await supabase
    .from('whatsapp_sessions').select('*').eq('phone_number', phone).single()

  if (!data) {
    const { data: newSession } = await supabase
      .from('whatsapp_sessions')
      .insert({ phone_number: phone, current_step: 'welcome', session_data: {} })
      .select().single()
    return newSession || { phone_number: phone, current_step: 'welcome', session_data: {} }
  }

  // Auto-expire after 30 minutes of inactivity
  if ((Date.now() - new Date(data.last_activity)) > 30 * 60 * 1000) {
    await supabase.from('whatsapp_sessions').update({
      current_step: 'welcome', session_data: {}, last_activity: new Date()
    }).eq('phone_number', phone)
    return { ...data, current_step: 'welcome', session_data: {} }
  }

  return data
}

async function updateSession(phone, step, sessionData) {
  await supabase.from('whatsapp_sessions').upsert(
    { phone_number: phone, current_step: step, session_data: sessionData, last_activity: new Date().toISOString() },
    { onConflict: 'phone_number' }
  )
}

async function resetSession(phone) {
  await supabase.from('whatsapp_sessions').upsert(
    { phone_number: phone, current_step: 'welcome', session_data: {}, last_activity: new Date().toISOString() },
    { onConflict: 'phone_number' }
  )
}

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'SchoolPay Bot', time: new Date().toISOString() }))

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`🚀 SchoolPay Bot running on port ${PORT}`))
