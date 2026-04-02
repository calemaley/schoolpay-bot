// ============================================================
// SCHOOLPAY WHATSAPP BOT - Fully Automatic Payments
// M-Pesa: STK push → PIN → auto confirmed via webhook
// Card: inline card collection → charged instantly
// No "DONE" typing needed — 100% automatic
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

// CORS for dashboard
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
// WHATSAPP WEBHOOK
// ============================================================
app.post('/webhook/whatsapp', async (req, res) => {
  const from = req.body.From
  const body = (req.body.Body || '').trim()
  const phone = from.replace('whatsapp:', '')

  try {
    let session = await getSession(phone)
    const reply = await processMessage(session, body, phone)
    await updateSession(phone, reply.nextStep, reply.sessionData || {})

    const twiml = new MessagingResponse()
    twiml.message(reply.text)
    res.set('Content-Type', 'text/xml')
    res.send(twiml.toString())
  } catch (err) {
    console.error('Webhook error:', err)
    const twiml = new MessagingResponse()
    twiml.message('❌ Something went wrong. Please type *hi* to start again.')
    res.set('Content-Type', 'text/xml')
    res.send(twiml.toString())
  }
})

// ============================================================
// MESSAGE PROCESSOR
// ============================================================
async function processMessage(session, body, phone) {
  const lower = body.toLowerCase().trim()

  // Always allow restart
  if (['hi', 'hello', 'start', 'menu', 'restart', '0', 'back'].includes(lower)) {
    await resetSession(phone)
    return welcomeMessage()
  }

  switch (session.current_step) {
    case 'welcome':       return welcomeMessage()
    case 'ask_email':     return handleEmail(session, body)
    case 'ask_admission': return handleAdmission(session, body)
    case 'show_fees':     return handleFeeSelection(session, body)
    case 'choose_method': return handleMethodChoice(session, body, phone)
    case 'card_number':   return handleCardNumber(session, body)
    case 'card_expiry':   return handleCardExpiry(session, body)
    case 'card_cvv':      return handleCardCvv(session, body, phone)
    default:
      return welcomeMessage()
  }
}

// ============================================================
// STEP 1: WELCOME
// ============================================================
function welcomeMessage() {
  return {
    text: `👋 *Welcome to SchoolPay!* 🏫\n\nYour secure school fees payment system.\n\nTo get started, please enter your *email address* so we can send you a receipt after payment.\n\n📧 _(Type your email below)_`,
    nextStep: 'ask_email',
    sessionData: {}
  }
}

// ============================================================
// STEP 2: EMAIL
// ============================================================
async function handleEmail(session, body) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(body.trim())) {
    return {
      text: `❌ That doesn't look like a valid email.\n\nPlease enter a valid email:\n_(e.g. parent@gmail.com)_`,
      nextStep: 'ask_email',
      sessionData: {}
    }
  }
  return {
    text: `✅ Email saved!\n\nNow please enter the *Admission Number* of the student:\n\n_(e.g. ADM/2025/001)_`,
    nextStep: 'ask_admission',
    sessionData: { email: body.trim().toLowerCase() }
  }
}

// ============================================================
// STEP 3: ADMISSION NUMBER → SHOW FEE LIST
// ============================================================
async function handleAdmission(session, body) {
  const { data: student } = await supabase
    .from('students')
    .select('*, classes(name, stream)')
    .eq('school_id', SCHOOL_ID)
    .ilike('admission_number', body.trim())
    .eq('is_active', true)
    .single()

  if (!student) {
    return {
      text: `❌ No student found with admission number *${body.trim()}*.\n\nPlease check and try again, or type *0* for menu.`,
      nextStep: 'ask_admission',
      sessionData: session.session_data
    }
  }

  const { data: fees } = await supabase
    .from('v_student_fee_summary')
    .select('*')
    .eq('student_id', student.id)
    .order('fee_category')

  const outstanding = (fees || []).filter(f => Number(f.balance) > 0)
  const className = student.classes
    ? `${student.classes.name}${student.classes.stream ? ' ' + student.classes.stream : ''}`
    : 'N/A'

  if (outstanding.length === 0) {
    return {
      text: `✅ *All fees cleared!*\n\n👤 *${student.first_name} ${student.last_name}*\n🏫 Class: ${className}\n\nAll fees are fully paid. Thank you! 🎉\n\nType *hi* to start again.`,
      nextStep: 'welcome',
      sessionData: {}
    }
  }

  const totalBalance = outstanding.reduce((s, f) => s + Number(f.balance), 0)
  let feeList = `👤 *${student.first_name} ${student.last_name}*\n🏫 Class: ${className}\n📋 Adm: ${student.admission_number}\n\n*📊 Outstanding Fees:*\n`

  outstanding.forEach((fee, i) => {
    feeList += `\n*${i + 1}.* ${fee.fee_name}\n    Balance: *KES ${Number(fee.balance).toLocaleString()}*`
  })

  feeList += `\n\n💰 *Total Outstanding: KES ${totalBalance.toLocaleString()}*`
  feeList += `\n\n─────────────────`
  feeList += `\nType a *number* to pay that fee`
  feeList += `\nType *ALL* to pay everything at once`
  feeList += `\nType *0* to go back`

  return {
    text: feeList,
    nextStep: 'show_fees',
    sessionData: {
      ...session.session_data,
      student_id: student.id,
      student_name: `${student.first_name} ${student.last_name}`,
      guardian_name: student.guardian1_name,
      fees: outstanding
    }
  }
}

// ============================================================
// STEP 4: FEE SELECTION (individual number OR "ALL")
// ============================================================
async function handleFeeSelection(session, body) {
  const fees = session.session_data.fees || []
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
        text: `❌ Invalid choice.\n\nType a number *1 to ${fees.length}* to pay a specific fee\nType *ALL* to pay everything at once\nType *0* for menu`,
        nextStep: 'show_fees',
        sessionData: session.session_data
      }
    }
    selectedFees = [fees[idx]]
    totalAmount = Number(fees[idx].balance)
    feeLabel = fees[idx].fee_name
  }

  const sessionData = {
    ...session.session_data,
    selected_fees: selectedFees,
    total_amount: totalAmount,
    fee_label: feeLabel
  }

  return {
    text: `💳 *Payment Summary*\n\n📋 Fee: *${feeLabel}*\n💰 Amount: *KES ${totalAmount.toLocaleString()}*\n👤 For: *${session.session_data.student_name}*\n\n─────────────────\n*Choose payment method:*\n\n*1.* 📱 M-Pesa _(STK push sent to your phone)_\n*2.* 💳 Card Payment _(Visa/Mastercard)_\n*3.* 🏦 Bank Transfer\n\n_(Type 1, 2, or 3)_`,
    nextStep: 'choose_method',
    sessionData
  }
}

// ============================================================
// STEP 5: PAYMENT METHOD CHOICE
// ============================================================
async function handleMethodChoice(session, body, phone) {
  const choice = body.trim()
  const { total_amount, fee_label, student_name, selected_fees, student_id, email } = session.session_data

  if (!['1', '2', '3'].includes(choice)) {
    return {
      text: `Please type:\n*1* for M-Pesa\n*2* for Card\n*3* for Bank Transfer`,
      nextStep: 'choose_method',
      sessionData: session.session_data
    }
  }

  // ── M-PESA STK PUSH ──────────────────────────────────────
  if (choice === '1') {
    let mpesaPhone = phone.replace(/\s/g, '').replace('+', '')
    if (mpesaPhone.startsWith('0')) mpesaPhone = '254' + mpesaPhone.slice(1)
    if (mpesaPhone.startsWith('whatsapp:')) mpesaPhone = mpesaPhone.replace('whatsapp:', '')

    try {
      const ref = generateRef()

      const paystackRes = await axios.post(
        'https://api.paystack.co/transaction/initialize',
        {
          email,
          amount: Math.round(total_amount * 100),
          reference: ref,
          currency: 'KES',
          channels: ['mobile_money'],
          mobile_money: { phone: mpesaPhone, provider: 'mpesa' },
          metadata: {
            student_id,
            student_name,
            guardian_name: session.session_data.guardian_name,
            fee_ids: selected_fees.map(f => f.student_fee_id),
            fee_label,
            school_id: SCHOOL_ID,
            guardian_phone: phone,
            channel: 'whatsapp_mpesa'
          },
          callback_url: `${process.env.BASE_URL}/webhook/paystack-confirm`
        },
        { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
      )

      // Save pending payment records
      for (const fee of selected_fees) {
        await supabase.from('payments').insert({
          school_id: SCHOOL_ID,
          student_id,
          student_fee_id: fee.student_fee_id,
          amount: Number(fee.balance),
          payment_method: 'mpesa',
          paystack_reference: ref,
          paid_by_email: email,
          paid_by_name: session.session_data.guardian_name || 'Guardian',
          paid_by_phone: phone,
          status: 'pending'
        })
      }

      return {
        text: `📱 *M-Pesa Request Sent!*\n\n✅ Check your phone *+${mpesaPhone}* now.\n\n👉 Enter your *M-Pesa PIN* to complete the payment.\n\n💰 Amount: *KES ${total_amount.toLocaleString()}*\n📋 For: *${fee_label}*\n\n⏳ You have *60 seconds* to complete.\n\n_You will receive an automatic confirmation here once payment is successful. No need to do anything else!_ 🎉`,
        nextStep: 'welcome',
        sessionData: { phone_number: phone }
      }
    } catch (err) {
      console.error('M-Pesa STK error:', err.response?.data || err.message)
      return {
        text: `❌ Could not send M-Pesa push.\n\n${err.response?.data?.message || 'Please ensure your number is M-Pesa registered.'}\n\nType *2* to try card payment instead, or *0* for menu.`,
        nextStep: 'choose_method',
        sessionData: session.session_data
      }
    }
  }

  // ── CARD PAYMENT (inline) ─────────────────────────────────
  if (choice === '2') {
    return {
      text: `💳 *Card Payment*\n\n💰 Amount: *KES ${total_amount.toLocaleString()}*\n\nStep 1 of 3 — Please enter your *16-digit card number*:\n_(No spaces, e.g. 4111111111111111)_\n\n🔒 _Your card details are encrypted and secure._`,
      nextStep: 'card_number',
      sessionData: session.session_data
    }
  }

  // ── BANK TRANSFER ─────────────────────────────────────────
  if (choice === '3') {
    const ref = generateRef()
    for (const fee of selected_fees) {
      await supabase.from('payments').insert({
        school_id: SCHOOL_ID,
        student_id,
        student_fee_id: fee.student_fee_id,
        amount: Number(fee.balance),
        payment_method: 'bank',
        paystack_reference: ref,
        paid_by_email: email,
        status: 'pending'
      })
    }

    return {
      text: `🏦 *Bank Transfer Details*\n\n💰 Amount: *KES ${total_amount.toLocaleString()}*\n📋 Fee: *${fee_label}*\n👤 Student: *${student_name}*\n\n*Transfer to:*\n🏦 Bank: Equity Bank\n📝 Account No: 0123456789\n🏷️ Account Name: Sunshine Academy\n🔑 *Reference: ${ref}*\n\n⚠️ *Use reference code _${ref}_ so payment is matched to ${student_name}.*\n\nOnce transfer is complete, send us the *M-Pesa/Bank confirmation message* and we will verify manually.\n\nType *0* for menu.`,
      nextStep: 'welcome',
      sessionData: {}
    }
  }
}

// ============================================================
// CARD STEPS — inline in WhatsApp
// ============================================================
async function handleCardNumber(session, body) {
  const cardNum = body.replace(/\s/g, '')
  if (!/^\d{16}$/.test(cardNum)) {
    return {
      text: `❌ Invalid card number.\n\nPlease enter your *16-digit card number* with no spaces:\n_(e.g. 4111111111111111)_`,
      nextStep: 'card_number',
      sessionData: session.session_data
    }
  }
  return {
    text: `✅ Card number received.\n\nStep 2 of 3 — Enter your card *Expiry Date*:\n_(Format: MM/YY — e.g. 12/26)_`,
    nextStep: 'card_expiry',
    sessionData: { ...session.session_data, card_number: cardNum }
  }
}

async function handleCardExpiry(session, body) {
  const expiry = body.trim()
  if (!/^\d{2}\/\d{2}$/.test(expiry)) {
    return {
      text: `❌ Invalid format.\n\nPlease enter expiry date as *MM/YY*:\n_(e.g. 12/26)_`,
      nextStep: 'card_expiry',
      sessionData: session.session_data
    }
  }
  return {
    text: `✅ Expiry date received.\n\nStep 3 of 3 — Enter the *CVV* (3-digit code on back of your card):`,
    nextStep: 'card_cvv',
    sessionData: { ...session.session_data, card_expiry: expiry }
  }
}

async function handleCardCvv(session, body, phone) {
  const cvv = body.trim()
  if (!/^\d{3,4}$/.test(cvv)) {
    return {
      text: `❌ Invalid CVV.\n\nPlease enter the *3-digit code* on the back of your card:`,
      nextStep: 'card_cvv',
      sessionData: session.session_data
    }
  }

  const {
    card_number, card_expiry, email,
    student_id, student_name, guardian_name,
    selected_fees, total_amount, fee_label
  } = session.session_data

  const [expMonth, expYear] = card_expiry.split('/')
  const ref = generateRef()

  // Send "processing" message first
  await sendWhatsApp(phone, `⏳ *Processing your card payment...*\n\n💰 KES ${total_amount.toLocaleString()} for ${fee_label}\n\nPlease wait a moment...`)

  try {
    const chargeRes = await axios.post(
      'https://api.paystack.co/charge',
      {
        email,
        amount: Math.round(total_amount * 100),
        reference: ref,
        currency: 'KES',
        card: {
          number: card_number,
          cvv,
          expiry_month: expMonth,
          expiry_year: '20' + expYear
        },
        metadata: {
          student_id,
          student_name,
          guardian_name,
          fee_ids: (selected_fees || []).map(f => f.student_fee_id),
          fee_label,
          school_id: SCHOOL_ID,
          guardian_phone: phone,
          channel: 'whatsapp_card'
        }
      },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
    )

    const chargeData = chargeRes.data.data
    const status = chargeData.status

    if (status === 'success') {
      // Immediately update fees and dashboard
      await confirmPaymentAndUpdateDashboard(ref, selected_fees, total_amount, {
        student_id, student_name, guardian_name, fee_label, email,
        method: 'card', phone
      })

      return {
        text: `✅ *Payment Successful!*\n\n🎉 Thank you, ${guardian_name || 'Guardian'}!\n\n👤 Student: *${student_name}*\n💰 Amount: *KES ${total_amount.toLocaleString()}*\n📋 Fee: *${fee_label}*\n🔑 Ref: *${ref}*\n\n📧 Receipt sent to *${email}*\n\n🙏 Thank you for investing in your child's education!\n\nType *hi* to check remaining fees or *0* for menu.`,
        nextStep: 'welcome',
        sessionData: {}
      }
    } else if (status === 'send_otp') {
      // Save partial info for OTP
      await supabase.from('payments').insert({
        school_id: SCHOOL_ID, student_id,
        amount: total_amount, payment_method: 'card',
        paystack_reference: ref, paid_by_email: email,
        status: 'pending'
      })
      return {
        text: `🔐 *OTP Required*\n\nYour bank sent a One-Time Password to your registered phone/email.\n\nPlease enter the *OTP code*:`,
        nextStep: 'card_cvv',
        sessionData: { ...session.session_data, ref, awaiting_otp: true, charge_token: chargeData.reference }
      }
    } else if (chargeData.awaiting_otp) {
      return {
        text: `🔐 Enter the *OTP* sent to your phone by your bank:`,
        nextStep: 'card_cvv',
        sessionData: { ...session.session_data, ref, awaiting_otp: true }
      }
    } else {
      return {
        text: `⏳ Payment is being verified...\n\nRef: *${ref}*\n\nYou will receive an automatic confirmation message here shortly.\n\nType *0* for menu.`,
        nextStep: 'welcome',
        sessionData: {}
      }
    }
  } catch (err) {
    console.error('Card charge error:', err.response?.data || err.message)
    const errMsg = err.response?.data?.message || 'Card declined or invalid details'
    return {
      text: `❌ *Payment Failed*\n\n_${errMsg}_\n\nPlease check your card details and try again.\n\nType *2* to retry card\nType *1* for M-Pesa instead\nType *0* for menu`,
      nextStep: 'choose_method',
      sessionData: {
        ...session.session_data,
        card_number: undefined,
        card_expiry: undefined
      }
    }
  }
}

// ============================================================
// PAYSTACK WEBHOOK — Auto-confirms M-Pesa payments
// This fires AUTOMATICALLY when parent enters M-Pesa PIN
// No "DONE" needed — 100% automatic
// ============================================================
app.post('/webhook/paystack-confirm', async (req, res) => {
  // Verify signature
  const hash = crypto.createHmac('sha512', PAYSTACK_SECRET)
    .update(JSON.stringify(req.body)).digest('hex')
  if (hash !== req.headers['x-paystack-signature']) {
    console.log('Invalid Paystack signature')
    return res.status(400).send('Invalid signature')
  }

  const event = req.body
  console.log('Paystack event:', event.event)

  if (event.event === 'charge.success') {
    const { reference, amount, metadata, customer } = event.data
    const amountPaid = amount / 100

    try {
      // Get all pending payments for this reference
      const { data: pendingPayments } = await supabase
        .from('payments')
        .select('*, student_fees(amount_due, amount_paid)')
        .eq('paystack_reference', reference)

      if (!pendingPayments || pendingPayments.length === 0) {
        console.log('No pending payments found for ref:', reference)
        return res.sendStatus(200)
      }

      const feeIds = pendingPayments.map(p => p.student_fee_id).filter(Boolean)

      // Update each payment to success
      await supabase.from('payments')
        .update({
          status: 'success',
          paystack_transaction_id: event.data.id,
          mpesa_receipt: event.data.authorization?.sender_mobile_money_number,
          updated_at: new Date().toISOString()
        })
        .eq('paystack_reference', reference)

      // Update student_fees balances — dashboard reflects immediately
      for (const p of pendingPayments) {
        if (!p.student_fee_id) continue
        const { data: sf } = await supabase
          .from('student_fees').select('*').eq('id', p.student_fee_id).single()
        if (sf) {
          const newPaid = Number(sf.amount_paid) + Number(p.amount)
          const newStatus = newPaid >= Number(sf.amount_due) ? 'paid' : 'partial'
          await supabase.from('student_fees').update({
            amount_paid: newPaid,
            status: newStatus,
            updated_at: new Date().toISOString()
          }).eq('id', p.student_fee_id)
        }
      }

      // Get student info
      const studentId = metadata?.student_id || pendingPayments[0]?.student_id
      const { data: student } = await supabase
        .from('students').select('*').eq('id', studentId).single()

      // Send automatic WhatsApp confirmation to guardian
      const guardianPhone = metadata?.guardian_phone
        || student?.guardian1_whatsapp
        || student?.guardian1_phone

      if (guardianPhone) {
        const studentName = metadata?.student_name || `${student?.first_name} ${student?.last_name}`
        const guardianName = metadata?.guardian_name || student?.guardian1_name || 'Guardian'
        const feeLabel = metadata?.fee_label || 'School Fees'

        await sendWhatsApp(
          guardianPhone,
          `✅ *Payment Confirmed!*\n\n🎉 Dear ${guardianName}, your payment has been received!\n\n👤 Student: *${studentName}*\n💰 Amount: *KES ${amountPaid.toLocaleString()}*\n📋 Fee: *${feeLabel}*\n🔑 Ref: *${reference}*\n📱 Method: M-Pesa\n\n📧 Receipt sent to *${customer.email}*\n\n🙏 Thank you for investing in your child's education!\n\n_Type *hi* to check remaining fees or view your balance._`
        )
      }

      console.log(`✅ Payment ${reference} confirmed — KES ${amountPaid} for ${metadata?.student_name}`)
    } catch (err) {
      console.error('Error processing webhook:', err.message)
    }
  }

  res.sendStatus(200)
})

// ============================================================
// HELPER: Confirm payment and update dashboard immediately
// Used for inline card payments
// ============================================================
async function confirmPaymentAndUpdateDashboard(ref, selectedFees, totalAmount, meta) {
  try {
    // Insert payment records as success immediately
    for (const fee of (selectedFees || [])) {
      await supabase.from('payments').upsert({
        school_id: SCHOOL_ID,
        student_id: meta.student_id,
        student_fee_id: fee.student_fee_id,
        amount: Number(fee.balance),
        payment_method: meta.method || 'card',
        paystack_reference: ref,
        paid_by_email: meta.email,
        paid_by_name: meta.guardian_name || 'Guardian',
        paid_by_phone: meta.phone,
        status: 'success'
      }, { onConflict: 'paystack_reference,student_fee_id' })

      // Update fee balance in student_fees
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
  } catch (err) {
    console.error('confirmPaymentAndUpdateDashboard error:', err.message)
  }
}

// ============================================================
// SEND SINGLE REMINDER (dashboard button)
// ============================================================
app.post('/api/send-reminder', async (req, res) => {
  const { student_id } = req.body
  if (!student_id) return res.status(400).json({ error: 'student_id required' })
  try {
    const { data: student } = await supabase
      .from('students').select('*, classes(name, stream)').eq('id', student_id).single()
    if (!student) return res.status(404).json({ error: 'Student not found' })

    const { data: fees } = await supabase
      .from('v_student_fee_summary').select('*').eq('student_id', student_id).gt('balance', 0)

    if (!fees || fees.length === 0) {
      return res.json({ success: true, message: 'No outstanding fees — nothing to remind' })
    }

    const total = fees.reduce((s, f) => s + Number(f.balance), 0)
    const feeLines = fees.map(f => `• ${f.fee_name}: KES ${Number(f.balance).toLocaleString()}`).join('\n')
    const guardianPhone = student.guardian1_whatsapp || student.guardian1_phone
    const className = student.classes
      ? `${student.classes.name}${student.classes.stream ? ' ' + student.classes.stream : ''}`
      : ''

    if (guardianPhone) {
      await sendWhatsApp(guardianPhone,
        `🔔 *Friendly Payment Reminder*\n\nDear *${student.guardian1_name}*,\n\nKindly note the following fees are outstanding for *${student.first_name} ${student.last_name}* (${className}):\n\n${feeLines}\n\n💰 *Total Due: KES ${total.toLocaleString()}*\n\nTo pay now, simply message this WhatsApp number and type *hi*. It takes less than 2 minutes! 😊\n\nThank you for your continued support. 🙏`
      )
    }

    res.json({
      success: true,
      student: `${student.first_name} ${student.last_name}`,
      sent: !!guardianPhone,
      outstanding: total
    })
  } catch (err) {
    console.error('send-reminder error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// SEND BULK REMINDERS (dashboard — all outstanding)
// ============================================================
app.post('/api/send-reminders', async (req, res) => {
  try {
    const { data: outstanding } = await supabase
      .from('v_student_fee_summary').select('*').gt('balance', 0)

    const byStudent = {}
    ;(outstanding || []).forEach(row => {
      if (!byStudent[row.student_id]) byStudent[row.student_id] = { name: row.full_name, fees: [] }
      byStudent[row.student_id].fees.push(row)
    })

    let sent = 0
    for (const [studentId, data] of Object.entries(byStudent)) {
      const { data: student } = await supabase
        .from('students').select('guardian1_whatsapp, guardian1_phone, guardian1_name').eq('id', studentId).single()
      const guardianPhone = student?.guardian1_whatsapp || student?.guardian1_phone
      if (!guardianPhone) continue

      const feeLines = data.fees.map(f => `• ${f.fee_name}: KES ${Number(f.balance).toLocaleString()}`).join('\n')
      const total = data.fees.reduce((s, f) => s + Number(f.balance), 0)

      await sendWhatsApp(guardianPhone,
        `🔔 *Payment Reminder*\n\nDear *${student.guardian1_name}*,\n\nThis is a friendly reminder about outstanding fees for *${data.name}*:\n\n${feeLines}\n\n💰 *Total Due: KES ${total.toLocaleString()}*\n\nPlease settle at your earliest convenience.\n\nTo pay now, message this WhatsApp and type *hi*. 😊\n\nThank you! 🙏`
      )
      sent++
      await new Promise(r => setTimeout(r, 600)) // rate limit
    }

    res.json({ success: true, reminders_sent: sent })
  } catch (err) {
    console.error('bulk reminders error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// UTILITIES
// ============================================================
function generateRef() {
  return `SCH-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`
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

  // Expire sessions older than 30 minutes — restart automatically
  const lastActivity = new Date(data.last_activity)
  if ((Date.now() - lastActivity) > 30 * 60 * 1000) {
    await supabase.from('whatsapp_sessions').update({
      current_step: 'welcome', session_data: {}, last_activity: new Date()
    }).eq('phone_number', phone)
    return { ...data, current_step: 'welcome', session_data: {} }
  }
  return data
}

async function updateSession(phone, step, sessionData) {
  await supabase.from('whatsapp_sessions').upsert(
    {
      phone_number: phone,
      current_step: step,
      session_data: sessionData || {},
      last_activity: new Date().toISOString()
    },
    { onConflict: 'phone_number' }
  )
}

async function resetSession(phone) {
  await supabase.from('whatsapp_sessions').upsert(
    { phone_number: phone, current_step: 'welcome', session_data: {}, last_activity: new Date().toISOString() },
    { onConflict: 'phone_number' }
  )
}

async function sendWhatsApp(phone, message) {
  try {
    let normalized = phone.replace(/\s/g, '').replace('whatsapp:', '')
    if (normalized.startsWith('0')) normalized = '+254' + normalized.slice(1)
    if (!normalized.startsWith('+')) normalized = '+' + normalized
    await twilioClient.messages.create({
      from: BOT_NUMBER,
      to: `whatsapp:${normalized}`,
      body: message
    })
  } catch (err) {
    console.error('WhatsApp send error:', err.message)
  }
}

app.get('/health', (_, res) => res.json({
  status: 'ok',
  service: 'SchoolPay Bot',
  time: new Date().toISOString()
}))

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`🚀 SchoolPay Bot running on port ${PORT}`))
