// ============================================================
// SCHOOLPAY WHATSAPP BOT - Fixed M-Pesa STK + Reminders
// Uses /charge endpoint for real STK push (not /initialize)
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

// CORS
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
// PHONE NUMBER NORMALIZER
// Converts any format to 254XXXXXXXXX for Paystack
// and +254XXXXXXXXX for WhatsApp
// ============================================================
function normalizeForPaystack(phone) {
  // Strip everything non-numeric
  let num = phone.replace(/\D/g, '')
  // Remove leading 254 if already there then re-add
  if (num.startsWith('254')) num = num.slice(3)
  if (num.startsWith('0')) num = num.slice(1)
  return '254' + num // Paystack wants: 254712345678
}

function normalizeForWhatsapp(phone) {
  let num = phone.replace(/\D/g, '')
  if (num.startsWith('254')) num = num.slice(3)
  if (num.startsWith('0')) num = num.slice(1)
  return '+254' + num // WhatsApp wants: +254712345678
}

// ============================================================
// WHATSAPP WEBHOOK
// ============================================================
app.post('/webhook/whatsapp', async (req, res) => {
  const from = req.body.From // e.g. whatsapp:+254712345678
  const body = (req.body.Body || '').trim()
  // Extract pure phone number
  const phone = from.replace('whatsapp:', '') // +254712345678

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
    default:              return welcomeMessage()
  }
}

// ── WELCOME ───────────────────────────────────────────────────
function welcomeMessage() {
  return {
    text: `👋 *Welcome to SchoolPay!* 🏫\n\nYour secure school fees payment system.\n\nPlease enter your *email address* so we can send you a receipt after payment.\n\n📧 _(Type your email below)_`,
    nextStep: 'ask_email',
    sessionData: {}
  }
}

// ── EMAIL ─────────────────────────────────────────────────────
async function handleEmail(session, body) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(body.trim())) {
    return {
      text: `❌ Invalid email. Please enter a valid email:\n_(e.g. parent@gmail.com)_`,
      nextStep: 'ask_email',
      sessionData: {}
    }
  }
  return {
    text: `✅ Email saved!\n\nNow enter the *Admission Number* of the student:\n_(e.g. ADM/2025/001)_`,
    nextStep: 'ask_admission',
    sessionData: { email: body.trim().toLowerCase() }
  }
}

// ── ADMISSION NUMBER ──────────────────────────────────────────
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
      text: `❌ No student found with admission number *${body.trim()}*.\n\nCheck and try again, or type *0* for menu.`,
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
  let msg = `👤 *${student.first_name} ${student.last_name}*\n🏫 ${className} | ${student.admission_number}\n\n*📊 Outstanding Fees:*\n`
  outstanding.forEach((f, i) => {
    msg += `\n*${i + 1}.* ${f.fee_name} — *KES ${Number(f.balance).toLocaleString()}*`
  })
  msg += `\n\n💰 *Total: KES ${totalBalance.toLocaleString()}*`
  msg += `\n\n─────────────────`
  msg += `\nType a *number* to pay one fee`
  msg += `\nType *ALL* to pay everything`
  msg += `\nType *0* to go back`

  return {
    text: msg,
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

// ── FEE SELECTION ─────────────────────────────────────────────
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
        text: `❌ Invalid choice.\n\nType *1 to ${fees.length}* for a specific fee\nType *ALL* for everything\nType *0* for menu`,
        nextStep: 'show_fees',
        sessionData: session.session_data
      }
    }
    selectedFees = [fees[idx]]
    totalAmount = Number(fees[idx].balance)
    feeLabel = fees[idx].fee_name
  }

  return {
    text: `💳 *Payment Summary*\n\n📋 ${feeLabel}\n💰 *KES ${totalAmount.toLocaleString()}*\n👤 ${session.session_data.student_name}\n\n─────────────────\n*Choose payment method:*\n\n*1.* 📱 M-Pesa _(STK push to your phone)_\n*2.* 💳 Card _(Visa / Mastercard)_\n*3.* 🏦 Bank Transfer\n\n_(Type 1, 2, or 3)_`,
    nextStep: 'choose_method',
    sessionData: {
      ...session.session_data,
      selected_fees: selectedFees,
      total_amount: totalAmount,
      fee_label: feeLabel
    }
  }
}

// ── PAYMENT METHOD ────────────────────────────────────────────
async function handleMethodChoice(session, body, phone) {
  const choice = body.trim()
  const { total_amount, fee_label, student_name, selected_fees, student_id, email, guardian_name } = session.session_data

  if (!['1', '2', '3'].includes(choice)) {
    return {
      text: `Type *1* M-Pesa, *2* Card, or *3* Bank Transfer`,
      nextStep: 'choose_method',
      sessionData: session.session_data
    }
  }

  // ── M-PESA STK PUSH ──────────────────────────────────────
  if (choice === '1') {
    // Correct format for Paystack M-Pesa: 254XXXXXXXXX (no + sign)
    const mpesaPhone = normalizeForPaystack(phone)
    const ref = generateRef()

    console.log(`Initiating M-Pesa STK for ${mpesaPhone}, amount: ${total_amount}`)

    try {
      // Use /charge endpoint — this triggers STK push directly
      const chargeRes = await axios.post(
        'https://api.paystack.co/charge',
        {
          email,
          amount: Math.round(total_amount * 100), // in kobo/cents
          currency: 'KES',
          reference: ref,
          mobile_money: {
            phone: mpesaPhone,    // 254712345678 format
            provider: 'mpesa'
          },
          metadata: {
            student_id,
            student_name,
            guardian_name,
            fee_ids: selectedFees.map(f => f.student_fee_id),
            fee_label,
            school_id: SCHOOL_ID,
            guardian_phone: phone, // original +254... format
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

      const responseData = chargeRes.data
      console.log('Paystack charge response:', JSON.stringify(responseData))

      if (responseData.status === false) {
        throw new Error(responseData.message || 'Paystack rejected the request')
      }

      const chargeStatus = responseData.data?.status

      // Save pending payment records
      for (const fee of selectedFees) {
        await supabase.from('payments').insert({
          school_id: SCHOOL_ID,
          student_id,
          student_fee_id: fee.student_fee_id,
          amount: Number(fee.balance),
          payment_method: 'mpesa',
          paystack_reference: ref,
          paid_by_email: email,
          paid_by_name: guardian_name || 'Guardian',
          paid_by_phone: phone,
          status: 'pending'
        })
      }

      if (chargeStatus === 'send_otp' || chargeStatus === 'pay_offline') {
        // STK push sent — parent will see it on their phone
        return {
          text: `📱 *M-Pesa Request Sent!*\n\n✅ A payment prompt has been sent to *${normalizeForWhatsapp(phone)}*\n\n👉 *Check your phone and enter your M-Pesa PIN now.*\n\n💰 Amount: *KES ${total_amount.toLocaleString()}*\n📋 Fee: *${fee_label}*\n\n⏳ You have *60 seconds* to complete.\n\n_You will receive an automatic confirmation here once payment is done. No further action needed!_ ✅`,
          nextStep: 'welcome',
          sessionData: { phone_number: phone }
        }
      } else if (chargeStatus === 'success') {
        // Instantly paid
        await confirmPaymentAndUpdate(ref, selectedFees, total_amount, { student_id, student_name, guardian_name, fee_label, email, method: 'mpesa', phone })
        return {
          text: `✅ *Payment Successful!*\n\n🎉 KES ${total_amount.toLocaleString()} received!\n\nReceipt sent to *${email}* 🙏`,
          nextStep: 'welcome',
          sessionData: {}
        }
      } else {
        return {
          text: `📱 *M-Pesa Request Sent!*\n\nCheck your phone *${normalizeForWhatsapp(phone)}* and enter your PIN.\n\n💰 *KES ${total_amount.toLocaleString()}*\n\n_You'll get a confirmation here automatically when payment is received._ ✅`,
          nextStep: 'welcome',
          sessionData: { phone_number: phone }
        }
      }
    } catch (err) {
      const errMsg = err.response?.data?.message || err.message || 'Unknown error'
      console.error('M-Pesa STK error:', errMsg, err.response?.data)
      return {
        text: `❌ *M-Pesa Failed*\n\n_${errMsg}_\n\nPossible reasons:\n• Phone not registered on M-Pesa\n• Wrong number format\n\nTry:\n*2* → Pay by card instead\n*0* → Main menu`,
        nextStep: 'choose_method',
        sessionData: session.session_data
      }
    }
  }

  // ── CARD PAYMENT ──────────────────────────────────────────
  if (choice === '2') {
    return {
      text: `💳 *Card Payment*\n\n💰 Amount: *KES ${total_amount.toLocaleString()}*\n\n*Step 1 of 3* — Enter your *16-digit card number*:\n_(No spaces — e.g. 4111111111111111)_\n\n🔒 _Secured by Paystack_`,
      nextStep: 'card_number',
      sessionData: session.session_data
    }
  }

  // ── BANK TRANSFER ─────────────────────────────────────────
  if (choice === '3') {
    const ref = generateRef()
    for (const fee of selectedFees) {
      await supabase.from('payments').insert({
        school_id: SCHOOL_ID, student_id,
        student_fee_id: fee.student_fee_id,
        amount: Number(fee.balance),
        payment_method: 'bank',
        paystack_reference: ref,
        paid_by_email: email,
        status: 'pending'
      })
    }
    return {
      text: `🏦 *Bank Transfer Details*\n\n💰 Amount: *KES ${total_amount.toLocaleString()}*\n📋 Fee: *${fee_label}*\n👤 Student: *${student_name}*\n\n━━━━━━━━━━━━━━━━\n🏦 Bank: *Equity Bank*\n📝 Account: *0123456789*\n🏷️ Name: *Sunshine Academy*\n🔑 Ref: *${ref}*\n━━━━━━━━━━━━━━━━\n\n⚠️ Use reference *${ref}* when transferring.\n\nSend the bank confirmation screenshot to this WhatsApp after payment.\n\nType *0* for menu.`,
      nextStep: 'welcome',
      sessionData: {}
    }
  }
}

// ── CARD STEPS ────────────────────────────────────────────────
async function handleCardNumber(session, body) {
  const cardNum = body.replace(/\s/g, '')
  if (!/^\d{16}$/.test(cardNum)) {
    return {
      text: `❌ Invalid. Enter your *16-digit card number* (no spaces):`,
      nextStep: 'card_number',
      sessionData: session.session_data
    }
  }
  return {
    text: `✅ Card saved.\n\n*Step 2 of 3* — Enter *Expiry Date*:\n_(Format: MM/YY — e.g. 12/26)_`,
    nextStep: 'card_expiry',
    sessionData: { ...session.session_data, card_number: cardNum }
  }
}

async function handleCardExpiry(session, body) {
  if (!/^\d{2}\/\d{2}$/.test(body.trim())) {
    return {
      text: `❌ Invalid format. Enter expiry as *MM/YY*:\n_(e.g. 12/26)_`,
      nextStep: 'card_expiry',
      sessionData: session.session_data
    }
  }
  return {
    text: `✅ Expiry saved.\n\n*Step 3 of 3* — Enter your *CVV*:\n_(3-digit code on back of card)_`,
    nextStep: 'card_cvv',
    sessionData: { ...session.session_data, card_expiry: body.trim() }
  }
}

async function handleCardCvv(session, body, phone) {
  if (!/^\d{3,4}$/.test(body.trim())) {
    return {
      text: `❌ Invalid CVV. Enter the *3-digit code* on back of your card:`,
      nextStep: 'card_cvv',
      sessionData: session.session_data
    }
  }

  const { card_number, card_expiry, email, student_id, student_name, guardian_name, selected_fees, total_amount, fee_label } = session.session_data
  const [expMonth, expYear] = card_expiry.split('/')
  const ref = generateRef()

  await sendWhatsApp(phone, `⏳ *Processing payment...*\n\n💰 KES ${total_amount.toLocaleString()} — Please wait...`)

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
          cvv: body.trim(),
          expiry_month: expMonth,
          expiry_year: '20' + expYear
        },
        metadata: {
          student_id, student_name, guardian_name,
          fee_ids: (selected_fees || []).map(f => f.student_fee_id),
          fee_label, school_id: SCHOOL_ID,
          guardian_phone: phone,
          channel: 'whatsapp_card'
        }
      },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' } }
    )

    const chargeData = chargeRes.data.data
    const status = chargeData?.status

    if (status === 'success') {
      await confirmPaymentAndUpdate(ref, selected_fees, total_amount, {
        student_id, student_name, guardian_name, fee_label, email, method: 'card', phone
      })
      return {
        text: `✅ *Card Payment Successful!*\n\n🎉 Thank you, ${guardian_name}!\n\n👤 *${student_name}*\n💰 *KES ${total_amount.toLocaleString()}*\n📋 ${fee_label}\n🔑 Ref: ${ref}\n\n📧 Receipt → *${email}*\n\n🙏 Thank you for investing in your child's education!\n\nType *hi* to check other fees.`,
        nextStep: 'welcome',
        sessionData: {}
      }
    } else {
      return {
        text: `⏳ Payment pending verification.\nRef: *${ref}*\n\nYou'll receive confirmation automatically. Type *0* for menu.`,
        nextStep: 'welcome',
        sessionData: {}
      }
    }
  } catch (err) {
    const errMsg = err.response?.data?.message || 'Card declined'
    console.error('Card charge error:', errMsg)
    return {
      text: `❌ *Card Failed*\n\n_${errMsg}_\n\nType *2* to retry or *1* for M-Pesa\nType *0* for menu`,
      nextStep: 'choose_method',
      sessionData: { ...session.session_data, card_number: undefined, card_expiry: undefined }
    }
  }
}

// ============================================================
// PAYSTACK WEBHOOK — Auto fires when M-Pesa PIN entered
// ============================================================
app.post('/webhook/paystack-confirm', async (req, res) => {
  const hash = crypto.createHmac('sha512', PAYSTACK_SECRET)
    .update(JSON.stringify(req.body)).digest('hex')
  if (hash !== req.headers['x-paystack-signature']) return res.status(400).send('Bad signature')

  const event = req.body
  console.log('Paystack webhook event:', event.event)

  if (event.event === 'charge.success') {
    const { reference, amount, metadata, customer } = event.data
    const amountPaid = amount / 100

    try {
      // Get pending payments
      const { data: pendingPayments } = await supabase
        .from('payments').select('*').eq('paystack_reference', reference)

      // Mark all as success
      await supabase.from('payments').update({
        status: 'success',
        paystack_transaction_id: event.data.id,
        mpesa_receipt: event.data.authorization?.sender_mobile_money_number,
        updated_at: new Date().toISOString()
      }).eq('paystack_reference', reference)

      // Update each fee balance → dashboard reflects immediately
      for (const p of (pendingPayments || [])) {
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
      const guardianPhone = metadata?.guardian_phone
      if (guardianPhone) {
        const studentName = metadata?.student_name || 'Student'
        const guardianName = metadata?.guardian_name || 'Guardian'
        const feeLabel = metadata?.fee_label || 'School Fees'

        await sendWhatsApp(
          guardianPhone,
          `✅ *Payment Confirmed!*\n\n🎉 Dear ${guardianName}, your payment was received!\n\n👤 Student: *${studentName}*\n💰 Amount: *KES ${amountPaid.toLocaleString()}*\n📋 Fee: *${feeLabel}*\n🔑 Ref: *${reference}*\n📱 Method: M-Pesa\n\n📧 Receipt → *${customer.email}*\n\n🙏 Thank you for investing in your child's education!\n\nType *hi* to check remaining fees.`
        )
      }

      console.log(`✅ Confirmed: ${reference} — KES ${amountPaid}`)
    } catch (err) {
      console.error('Webhook processing error:', err.message)
    }
  }

  res.sendStatus(200)
})

// ============================================================
// SEND SINGLE REMINDER (dashboard → bot → WhatsApp)
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
    const feeLines = fees.map(f => `• ${f.fee_name}: KES ${Number(f.balance).toLocaleString()}`).join('\n')
    const className = student.classes
      ? `${student.classes.name}${student.classes.stream ? ' ' + student.classes.stream : ''}`
      : ''

    // Get guardian WhatsApp — use guardian1_whatsapp first, fall back to guardian1_phone
    const rawPhone = student.guardian1_whatsapp || student.guardian1_phone
    if (!rawPhone) {
      return res.status(400).json({ error: 'No phone number for guardian' })
    }

    const guardianPhone = normalizeForWhatsapp(rawPhone)
    console.log(`Sending reminder to guardian: ${guardianPhone}`)

    await sendWhatsApp(
      guardianPhone,
      `🔔 *Friendly Payment Reminder*\n\nDear *${student.guardian1_name}*,\n\nThe following fees are outstanding for *${student.first_name} ${student.last_name}* (${className}):\n\n${feeLines}\n\n💰 *Total Due: KES ${total.toLocaleString()}*\n\nTo pay now, message this WhatsApp and type *hi*. 😊\n\nThank you for your support! 🙏`
    )

    res.json({ success: true, sent_to: guardianPhone, student: `${student.first_name} ${student.last_name}`, outstanding: total })
  } catch (err) {
    console.error('send-reminder error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// SEND BULK REMINDERS
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
        .from('students')
        .select('guardian1_whatsapp, guardian1_phone, guardian1_name')
        .eq('id', studentId)
        .single()

      const rawPhone = student?.guardian1_whatsapp || student?.guardian1_phone
      if (!rawPhone) continue

      const guardianPhone = normalizeForWhatsapp(rawPhone)
      const feeLines = data.fees.map(f => `• ${f.fee_name}: KES ${Number(f.balance).toLocaleString()}`).join('\n')
      const total = data.fees.reduce((s, f) => s + Number(f.balance), 0)

      await sendWhatsApp(
        guardianPhone,
        `🔔 *Payment Reminder*\n\nDear *${student.guardian1_name}*,\n\nOutstanding fees for *${data.name}*:\n\n${feeLines}\n\n💰 *Total: KES ${total.toLocaleString()}*\n\nMessage *hi* here to pay now. Takes 2 minutes! 😊\n\nThank you! 🙏`
      )
      sent++
      await new Promise(r => setTimeout(r, 700))
    }

    res.json({ success: true, reminders_sent: sent })
  } catch (err) {
    console.error('bulk reminders error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// HELPERS
// ============================================================
async function confirmPaymentAndUpdate(ref, selectedFees, totalAmount, meta) {
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
    }, { onConflict: 'paystack_reference' })

    const { data: sf } = await supabase.from('student_fees').select('*').eq('id', fee.student_fee_id).single()
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
    const normalized = normalizeForWhatsapp(phone)
    console.log(`Sending WhatsApp to: whatsapp:${normalized}`)
    await twilioClient.messages.create({
      from: BOT_NUMBER,
      to: `whatsapp:${normalized}`,
      body: message
    })
    console.log(`✅ WhatsApp sent to ${normalized}`)
  } catch (err) {
    console.error(`❌ WhatsApp send error to ${phone}:`, err.message)
  }
}

async function getSession(phone) {
  const { data } = await supabase
    .from('whatsapp_sessions').select('*').eq('phone_number', phone).single()

  if (!data) {
    const { data: s } = await supabase
      .from('whatsapp_sessions')
      .insert({ phone_number: phone, current_step: 'welcome', session_data: {} })
      .select().single()
    return s || { phone_number: phone, current_step: 'welcome', session_data: {} }
  }

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
    { phone_number: phone, current_step: step, session_data: sessionData || {}, last_activity: new Date().toISOString() },
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
