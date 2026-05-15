// ============================================================
// SCHOOLPAY BOT — Twilio (WhatsApp) + Africa's Talking (SMS + USSD)
// ============================================================
const express = require('express')
const { createClient } = require('@supabase/supabase-js')
const twilio = require('twilio')
const AfricasTalking = require('africastalking')
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
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
const MessagingResponse = twilio.twiml.MessagingResponse
const BOT_NUMBER = `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`

const AT = AfricasTalking({ username: process.env.AT_USERNAME || 'sandbox', apiKey: process.env.AT_API_KEY })
const atSMS = AT.SMS
const AT_SENDER = process.env.AT_SENDER_ID || 'SchoolPay'

const SCHOOL_ID = process.env.SCHOOL_ID
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY

// ============================================================
// PHONE HELPERS
// ============================================================
function toPaystackPhone(raw) {
  let n = raw.replace(/\D/g, '')
  if (n.startsWith('254')) n = n.slice(3)
  if (n.startsWith('0')) n = n.slice(1)
  return '+254' + n
}

function toE164(raw) {
  let n = raw.replace(/\D/g, '')
  if (n.startsWith('254')) n = n.slice(3)
  if (n.startsWith('0')) n = n.slice(1)
  return '+254' + n
}

function generateRef() {
  return `SCH-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`
}

// Strip WhatsApp markdown so SMS arrives as clean plain text
function stripMarkdown(text) {
  return text.replace(/\*/g, '').replace(/_/g, '').replace(/━/g, '-').trim()
}

// ============================================================
// SEND HELPERS
// ============================================================
async function sendWA(phone, message) {
  try {
    const to = `whatsapp:${toE164(phone)}`
    console.log(`[WA] Sending to ${to}`)
    const r = await twilioClient.messages.create({ from: BOT_NUMBER, to, body: message })
    console.log(`[WA] ✅ Sent SID: ${r.sid}`)
  } catch (err) {
    console.error(`[WA] ❌ Failed to ${phone}:`, err.message)
  }
}

async function sendSMS(phone, message) {
  try {
    const to = toE164(phone)
    console.log(`[SMS] Sending to ${to}`)
    const result = await atSMS.send({ to: [to], message, from: AT_SENDER })
    console.log(`[SMS] ✅`, JSON.stringify(result))
  } catch (err) {
    console.error(`[SMS] ❌ Failed to ${phone}:`, err.message)
  }
}

// ============================================================
// PAYMENT SUCCESS MESSAGE WITH REMAINING BALANCE
// ============================================================
async function buildSuccessMessage(studentId, paidAmount, feeLabel, ref, email, guardianName, studentName) {
  let remainingSection = ''
  try {
    const { data: remaining } = await supabase
      .from('v_student_fee_summary')
      .select('fee_name, balance, due_date')
      .eq('student_id', studentId)
      .gt('balance', 0)
      .order('fee_category')

    const outstanding = (remaining || []).filter(f => Number(f.balance) > 0)
    const totalRemaining = outstanding.reduce((s, f) => s + Number(f.balance), 0)

    if (outstanding.length === 0) {
      remainingSection  = `\n\n🎊 *All school fees are now fully cleared!*`
      remainingSection += `\nNo outstanding balance remaining. Well done! 🏆`
    } else {
      remainingSection  = `\n\n📋 *Remaining Balance*\n`
      outstanding.forEach((f, i) => {
        remainingSection += `\n  ${i + 1}. ${f.fee_name}`
        remainingSection += `\n     *KES ${Number(f.balance).toLocaleString()}*`
        if (f.due_date) {
          const due = new Date(f.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
          remainingSection += ` — _due ${due}_`
        }
      })
      remainingSection += `\n\n💰 *Total Remaining: KES ${totalRemaining.toLocaleString()}*`
      remainingSection += `\n\n_Kindly clear the remaining fees before the deadlines to avoid disruption to your child's studies._`
    }
  } catch (e) {
    console.error('buildSuccessMessage balance error:', e.message)
  }

  let msg = ``
  msg += `✅ *Payment Confirmed!*\n`
  msg += `━━━━━━━━━━━━━━━━━━━━\n\n`
  msg += `Dear *${guardianName}*, 🎉\n\n`
  msg += `Your payment has been successfully received.\n\n`
  msg += `  👤 Student:   *${studentName}*\n`
  msg += `  💰 Amount:    *KES ${Number(paidAmount).toLocaleString()}*\n`
  msg += `  📋 Fee:       ${feeLabel}\n`
  msg += `  🔑 Reference: \`${ref}\`\n`
  if (email) msg += `  📧 Receipt:   ${email}\n`
  msg += `\n━━━━━━━━━━━━━━━━━━━━`
  msg += remainingSection
  msg += `\n━━━━━━━━━━━━━━━━━━━━`
  msg += `\n\n🙏 Thank you for investing in *${studentName.split(' ')[0]}'s* education!\n\n`
  msg += `_Type *balance* to check fees · *hi* to make another payment_`

  return msg
}

// ============================================================
// WHATSAPP WEBHOOK (Twilio)
// ============================================================
app.post('/webhook/whatsapp', async (req, res) => {
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
    console.error('WA Bot error:', err.message, err.stack)
  }

  twiml.message(replyText)
  res.set('Content-Type', 'text/xml')
  res.send(twiml.toString())
})

// ============================================================
// SMS INCOMING WEBHOOK (Africa's Talking)
// ============================================================
app.post('/webhook/sms', async (req, res) => {
  res.sendStatus(200)
  const from = req.body.from || ''
  const body = (req.body.text || '').trim()
  const phone = toE164(from)
  console.log(`[SMS IN] From: ${phone} | Text: ${body}`)
  try {
    const session = await getSession(phone)
    const reply = await handleMessage(session, body, phone)
    await updateSession(phone, reply.nextStep, reply.sessionData || {})
    await sendSMS(phone, stripMarkdown(reply.text))
  } catch (err) {
    console.error('SMS Bot error:', err.message, err.stack)
    await sendSMS(phone, 'Error. Text hi to restart.')
  }
})

app.post('/webhook/delivery', (req, res) => {
  console.log('[DELIVERY]', req.body)
  res.sendStatus(200)
})

// ============================================================
// USSD WEBHOOK (Africa's Talking)
// ============================================================
app.post('/webhook/ussd', async (req, res) => {
  const { sessionId, phoneNumber, text } = req.body
  const phone = toE164(phoneNumber)
  const parts = text ? text.split('*') : []
  console.log(`[USSD] ${phone} | text: "${text}"`)
  let response = ''
  try {
    response = await handleUSSD(sessionId, phone, parts)
  } catch (err) {
    console.error('[USSD] Error:', err.message)
    response = 'END Service error. Please try again.'
  }
  res.set('Content-Type', 'text/plain')
  res.send(response)
})

// ============================================================
// USSD FLOW
// ============================================================
async function handleUSSD(sessionId, phone, parts) {
  const depth = parts.length
  const p = (i) => parts[i] || ''

  if (depth === 0 || (depth === 1 && p(0) === '')) {
    return 'CON Welcome to SchoolPay\n1. Pay Fees\n2. Check Balance\n3. Check Results\n0. Exit'
  }

  const choice = p(0)
  if (choice === '0') return 'END Thank you for using SchoolPay!'

  if (choice === '1') {
    if (depth === 1) return 'CON Enter admission number:'

    const admission = p(1)
    if (depth === 2) {
      let student = null
      try {
        const { data: s } = await supabase
          .from('students').select('*, classes(name, stream)')
          .eq('school_id', SCHOOL_ID).ilike('admission_number', admission)
          .eq('is_active', true).single()
        student = s
      } catch (e) {}

      if (!student) return `END Student "${admission}" not found.\nCheck number and try again.`

      const { data: allFees } = await supabase
        .from('v_student_fee_summary').select('*')
        .eq('student_id', student.id).order('fee_category')

      const outstanding = (allFees || []).filter(f => Number(f.balance) > 0)
      if (!outstanding.length) {
        return `END All fees cleared!\n${student.first_name} ${student.last_name}\nhas no outstanding fees.`
      }

      const total = outstanding.reduce((s, f) => s + Number(f.balance), 0)
      await saveUssdSession(sessionId, {
        student_id: student.id,
        student_name: `${student.first_name} ${student.last_name}`,
        guardian_name: student.guardian1_name || 'Guardian',
        fees: outstanding
      })

      let msg = `CON ${student.first_name} ${student.last_name}\nOwed: KES ${total.toLocaleString()}\n`
      outstanding.slice(0, 5).forEach((f, i) => {
        const name = f.fee_name.length > 14 ? f.fee_name.substring(0, 14) + '.' : f.fee_name
        msg += `${i + 1}. ${name}: ${Number(f.balance).toLocaleString()}\n`
      })
      msg += `0. Pay All`
      return msg
    }

    if (depth === 3) {
      const feeChoice = p(2)
      const ussdData = await getUssdSession(sessionId)
      const fees = ussdData.fees || []
      let selectedFees = [], total = 0, label = ''

      if (feeChoice === '0') {
        selectedFees = fees
        total = fees.reduce((s, f) => s + Number(f.balance), 0)
        label = 'All Outstanding Fees'
      } else {
        const idx = parseInt(feeChoice) - 1
        if (isNaN(idx) || idx < 0 || idx >= fees.length) {
          return `CON Invalid choice.\nEnter 1-${fees.length} or 0 for All:`
        }
        selectedFees = [fees[idx]]
        total = Number(fees[idx].balance)
        label = fees[idx].fee_name
      }

      await saveUssdSession(sessionId, { ...ussdData, selected_fees: selectedFees, total_amount: total, fee_label: label })
      return `CON ${label}\nKES ${total.toLocaleString()}\n\n1. M-Pesa STK Push\n2. Bank Transfer\n0. Back`
    }

    if (depth === 4) {
      const methodChoice = p(3)
      const ussdData = await getUssdSession(sessionId)
      if (methodChoice === '1') return 'CON Enter M-Pesa number:\n(e.g. 0712345678)'
      if (methodChoice === '2') {
        const ref = generateRef()
        await savePendingUSSD(ussdData, ref, 'bank')
        return `END Bank Transfer\nKES ${Number(ussdData.total_amount).toLocaleString()}\n\nBank: Equity Bank\nAcc: 0123456789\nRef: ${ref}\n\nUse ref as payment reference.`
      }
      return 'CON Choose:\n1. M-Pesa\n2. Bank Transfer'
    }

    if (depth === 5) {
      const methodChoice = p(3)
      const mpesaPhone = p(4)
      const ussdData = await getUssdSession(sessionId)
      if (methodChoice === '1') {
        const digits = mpesaPhone.replace(/\D/g, '')
        if (digits.length < 9 || digits.length > 12) return 'CON Invalid number.\nEnter M-Pesa number:\n(e.g. 0712345678)'
        const paystackPhone = toPaystackPhone(mpesaPhone)
        const ref = generateRef()
        try {
          await axios.post('https://api.paystack.co/charge', {
            email: `ussd-${phone.replace(/\D/g, '')}@schoolpay.ke`,
            amount: Math.round(Number(ussdData.total_amount) * 100),
            currency: 'KES', reference: ref,
            mobile_money: { phone: paystackPhone, provider: 'mpesa' },
            metadata: {
              school_id: SCHOOL_ID, student_id: ussdData.student_id,
              student_name: ussdData.student_name, guardian_name: ussdData.guardian_name,
              fee_label: ussdData.fee_label,
              fee_ids: (ussdData.selected_fees || []).map(f => f.student_fee_id).join(','),
              guardian_phone: phone, channel: 'ussd_mpesa'
            }
          }, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' } })

          await savePendingUSSD(ussdData, ref, 'mpesa')
          return `END STK Push Sent!\n\nCheck ${paystackPhone}\nfor M-Pesa PIN prompt.\n\nKES ${Number(ussdData.total_amount).toLocaleString()}\nRef: ${ref}\n\nYou will receive SMS confirmation.`
        } catch (err) {
          const msg = err.response?.data?.message || 'Payment failed'
          return `END M-Pesa failed:\n${msg}\n\nDial again to retry.`
        }
      }
    }
  }

  if (choice === '2') {
    if (depth === 1) return 'CON Enter admission number:'
    if (depth === 2) {
      const admission = p(1)
      let student = null
      try {
        const { data: s } = await supabase
          .from('students').select('*, classes(name, stream)')
          .eq('school_id', SCHOOL_ID).ilike('admission_number', admission)
          .eq('is_active', true).single()
        student = s
      } catch (e) {}
      if (!student) return `END Student "${admission}" not found.`
      const { data: allFees } = await supabase
        .from('v_student_fee_summary').select('*')
        .eq('student_id', student.id).order('fee_category')
      const outstanding = (allFees || []).filter(f => Number(f.balance) > 0)
      if (!outstanding.length) return `END ${student.first_name} ${student.last_name}\nAll fees cleared!`
      const total = outstanding.reduce((s, f) => s + Number(f.balance), 0)
      let msg = `END ${student.first_name} ${student.last_name}\nOwed: KES ${total.toLocaleString()}\n`
      outstanding.slice(0, 5).forEach(f => {
        const name = f.fee_name.length > 14 ? f.fee_name.substring(0, 14) + '.' : f.fee_name
        msg += `${name}: KES ${Number(f.balance).toLocaleString()}\n`
      })
      msg += `\nText hi to pay via SMS`
      return msg
    }
  }

  // ── CHECK RESULTS (USSD) ──────────────────────────────────
  if (choice === '3') {
    if (depth === 1) return 'CON Enter admission number:'

    if (depth === 2) {
      const admission = p(1)
      let student = null
      try {
        const { data: s } = await supabase.from('students')
          .select('*, classes(name, stream)')
          .eq('school_id', SCHOOL_ID).ilike('admission_number', admission).eq('is_active', true).single()
        student = s
      } catch (e) {}
      if (!student) return `END Student "${admission}" not found.\nCheck number and try again.`

      const { data: available } = await supabase.from('student_results')
        .select('year, term').eq('student_id', student.id)
        .order('year', { ascending: false }).order('term')

      if (!available || !available.length) return `END ${student.first_name} ${student.last_name}\nNo results recorded yet.\n\nText results for full report.`

      const seen = new Set(), periods = []
      available.forEach(r => { const k=`${r.year}-${r.term}`; if(!seen.has(k)){seen.add(k);periods.push(r)} })

      await saveUssdSession(sessionId, {
        student_id: student.id,
        student_name: `${student.first_name} ${student.last_name}`,
        periods
      })

      let msg = `CON ${student.first_name} ${student.last_name}\nSelect period:\n`
      periods.slice(0, 5).forEach((pr, i) => { msg += `${i+1}. ${pr.year} Term ${pr.term}\n` })
      msg += `${Math.min(periods.length,5)+1}. All periods`
      return msg
    }

    if (depth === 3) {
      const pick = parseInt(p(2))
      const ussdData = await getUssdSession(sessionId)
      const periods = ussdData.periods || []
      const allChoice = Math.min(periods.length, 5) + 1

      let filterYear = null, filterTerm = null
      if (pick !== allChoice && pick >= 1 && pick <= periods.length) {
        filterYear = periods[pick - 1].year
        filterTerm = periods[pick - 1].term
      }

      let resQuery = supabase.from('student_results')
        .select('subject, marks_scored, total_marks')
        .eq('student_id', ussdData.student_id)
      if (filterYear) resQuery = resQuery.eq('year', filterYear)
      if (filterTerm) resQuery = resQuery.eq('term', filterTerm)
      const { data: res } = await resQuery

      if (!res || !res.length) return `END No results found.\nText results for full report.`

      const bySubj = {}
      res.forEach(r => {
        if (!bySubj[r.subject]) bySubj[r.subject] = []
        bySubj[r.subject].push(Math.round((r.marks_scored / r.total_marks) * 100))
      })

      const label = filterYear ? `${filterYear} T${filterTerm}` : 'All'
      let msg = `END ${ussdData.student_name}\n${label} Results:\n\n`
      const allAvgs = []
      Object.entries(bySubj).forEach(([subj, pcts]) => {
        const avg = Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length)
        const gr = gradeLabel(avg)
        const short = subj.length > 10 ? subj.substring(0, 10) + '.' : subj
        msg += `${short}: ${avg}% ${gr}\n`
        allAvgs.push(avg)
      })
      if (allAvgs.length) {
        const overall = Math.round(allAvgs.reduce((a, b) => a + b, 0) / allAvgs.length)
        msg += `\nOverall: ${overall}% ${gradeLabel(overall)}`
      }
      msg += `\n\nText results for full report.`
      return msg
    }
  }

  return 'END Invalid option. Please try again.'
}

// ============================================================
// USSD SESSION HELPERS
// ============================================================
async function saveUssdSession(sessionId, data) {
  try {
    await supabase.from('ussd_sessions').upsert(
      { session_id: sessionId, session_data: data, updated_at: new Date().toISOString() },
      { onConflict: 'session_id' }
    )
  } catch (err) { console.error('saveUssdSession error:', err.message) }
}

async function getUssdSession(sessionId) {
  try {
    const { data } = await supabase.from('ussd_sessions').select('session_data').eq('session_id', sessionId).single()
    return data?.session_data || {}
  } catch (err) { console.error('getUssdSession error:', err.message); return {} }
}

async function savePendingUSSD(ussdData, ref, method) {
  for (const fee of (ussdData.selected_fees || [])) {
    try {
      await supabase.from('payments').insert({
        school_id: SCHOOL_ID, student_id: ussdData.student_id,
        student_fee_id: fee.student_fee_id, amount: Number(fee.balance),
        payment_method: method, paystack_reference: ref,
        paid_by_name: ussdData.guardian_name || 'Guardian', status: 'pending'
      })
    } catch (e) { console.error('savePendingUSSD error:', e.message) }
  }
}

// ============================================================
// MESSAGE HANDLER — shared by WhatsApp + SMS
// ============================================================
async function handleMessage(session, body, phone) {
  const lower = body.toLowerCase().trim()
  const step = session.current_step || 'welcome'
  const data = session.session_data || {}
  const hist = data._hist || []

  // Balance — always works from any step
  if (lower === 'balance') return await showBalance(data, phone)

  // Results — always works from any step
  if (lower === 'results' || lower === 'r') return await showResults(data, phone)

  // Main menu — 6 or natural restart words
  if (['menu', '6', 'hi', 'hello', 'start', 'restart'].includes(lower)) {
    await resetSession(phone)
    return welcome()
  }

  // Go back one step — 0 or back
  if (['back', 'b', '0'].includes(lower)) {
    if (hist.length === 0) {
      return {
        text: `You're already at the start 😊\n\nType *hi* to begin\nType *balance* to check fees`,
        nextStep: 'welcome', sessionData: {}
      }
    }
    const prev = hist[hist.length - 1]
    const restoredData = { ...prev.data, _hist: hist.slice(0, -1) }
    return getStepPrompt(prev.step, restoredData)
  }

  // Process current step
  let result
  switch (step) {
    case 'welcome':         result = welcome(); break
    case 'ask_email':       result = askEmail(data, body); break
    case 'ask_admission':   result = await askAdmission(data, body); break
    case 'show_fees':       result = showFees(data, body); break
    case 'choose_method':   result = chooseMethod(data, body); break
    case 'ask_mpesa_phone': result = await doMpesa(data, body, phone); break
    case 'card_number':     result = cardNumber(data, body); break
    case 'card_expiry':     result = cardExpiry(data, body); break
    case 'card_cvv':            result = await cardCvv(data, body, phone); break
    case 'ask_results_adm':     result = await handleResultsAdmission(data, body); break
    case 'pick_results_period': result = await handleResultsPeriod(data, body); break
    default:                    result = welcome()
  }

  // Push current step to history when advancing forward (not on errors or resets to welcome)
  if (result.nextStep !== step && result.nextStep !== 'welcome' && step !== 'welcome') {
    const cleanData = { ...data }
    delete cleanData._hist
    const newHist = [...hist, { step, data: cleanData }].slice(-6)
    result.sessionData = { ...result.sessionData, _hist: newHist }
  } else if (result.nextStep !== 'welcome') {
    // Stayed on same step (validation error) — carry history forward
    result.sessionData = { ...result.sessionData, _hist: hist }
  }

  return result
}

// Re-renders the prompt for a step when user goes back
function getStepPrompt(step, data) {
  switch (step) {
    case 'welcome': return welcome()

    case 'ask_email': return {
      text: `📧 *Enter Your Email Address*\n\nPlease provide your email so we can send your payment receipt.\n\n  _(e.g. parent@gmail.com)_\n\n_*6* for main menu_`,
      nextStep: 'ask_email', sessionData: data
    }

    case 'ask_admission': return {
      text: `✅ Email on file: _${data.email}_\n\n🎓 *Enter Student Admission Number*\n\n  _(e.g. ADM/2025/001)_\n\n_*0* back · *6* menu_`,
      nextStep: 'ask_admission', sessionData: data
    }

    case 'show_fees': {
      const fees = data.fees || []
      if (!fees.length) return welcome()
      const total = fees.reduce((s, f) => s + Number(f.balance), 0)
      let msg = `📋 *Outstanding Fees*\n━━━━━━━━━━━━━━━━━━━━\n\n👤 *${data.student_name}*\n\n`
      fees.forEach((f, i) => {
        msg += `  *${i + 1}.* ${f.fee_name}\n`
        msg += `       *KES ${Number(f.balance).toLocaleString()}*\n\n`
      })
      msg += `━━━━━━━━━━━━━━━━━━━━\n💰 *Total Due: KES ${total.toLocaleString()}*\n━━━━━━━━━━━━━━━━━━━━\n\n`
      msg += `Reply with:\n  • A *number* to pay one fee _(e.g. 1)_\n  • *1,2* or *1,3* to pay multiple\n  • *ALL* to pay everything at once\n\n`
      msg += `_*0* back · *6* menu_`
      return { text: msg, nextStep: 'show_fees', sessionData: data }
    }

    case 'choose_method': return {
      text: `💳 *Payment Summary*\n━━━━━━━━━━━━━━━━━━━━\n\n  👤 ${data.student_name}\n  📋 ${data.fee_label}\n  💰 *KES ${Number(data.total_amount).toLocaleString()}*\n\n━━━━━━━━━━━━━━━━━━━━\n*Select Payment Method:*\n\n  *1* 📱  M-Pesa STK Push\n  *2* 💳  Card _(Visa / Mastercard)_\n  *3* 🏦  Bank Transfer\n\n━━━━━━━━━━━━━━━━━━━━\n_*0* back · *6* menu_`,
      nextStep: 'choose_method', sessionData: data
    }

    case 'ask_mpesa_phone': return {
      text: `📱 *M-Pesa Payment*\n━━━━━━━━━━━━━━━━━━━━\n\n  💰 *KES ${Number(data.total_amount).toLocaleString()}*\n  📋 ${data.fee_label}\n\nEnter the *M-Pesa number* to receive the payment prompt:\n\n  _(e.g. 0712 345 678)_\n\n_*0* back · *6* menu_`,
      nextStep: 'ask_mpesa_phone', sessionData: data
    }

    case 'card_number': return {
      text: `💳 *Card Payment — Step 1 of 3*\n━━━━━━━━━━━━━━━━━━━━\n\nPlease enter your *16-digit card number*:\n\n  _(No spaces — e.g. 4111 1111 1111 1111)_\n\n🔒 _Secured by Paystack_\n\n_*0* back · *6* menu_`,
      nextStep: 'card_number', sessionData: data
    }

    case 'card_expiry': return {
      text: `💳 *Card Payment — Step 2 of 3*\n━━━━━━━━━━━━━━━━━━━━\n\nEnter your card *Expiry Date*:\n\n  _(MM/YY — e.g. 12/26)_\n\n_*0* back · *6* menu_`,
      nextStep: 'card_expiry', sessionData: data
    }

    default: return welcome()
  }
}

// ============================================================
// RESULTS HELPERS
// ============================================================
function gradeLabel(pct) {
  if (pct >= 80) return 'A'
  if (pct >= 65) return 'B'
  if (pct >= 50) return 'C'
  if (pct >= 35) return 'D'
  return 'E'
}

function gradeRemark(pct) {
  if (pct >= 80) return 'Excellent'
  if (pct >= 65) return 'Good'
  if (pct >= 50) return 'Average'
  if (pct >= 35) return 'Below Average'
  return 'Needs Improvement'
}

const EXAM_LABELS = { cat: 'CAT', opener: 'Opener', quiz: 'Quiz', midterm: 'Midterm', endterm: 'Endterm' }

async function showResults(data, phone) {
  if (!data.student_id) {
    return {
      text: `📊 *Academic Results*\n━━━━━━━━━━━━━━━━━━━━\n\nPlease enter the student's *Admission Number*:\n\n  🎓 _(e.g. ADM/2025/001)_\n\n_*0* back · *6* menu_`,
      nextStep: 'ask_results_adm',
      sessionData: data
    }
  }
  return await buildPeriodPicker(data.student_id, data)
}

async function handleResultsAdmission(data, body) {
  let student = null
  try {
    const { data: s } = await supabase.from('students')
      .select('*, classes(name, stream)')
      .eq('school_id', SCHOOL_ID).ilike('admission_number', body.trim()).eq('is_active', true).single()
    student = s
  } catch (e) {}

  if (!student) {
    return {
      text: `❌ *Student Not Found*\n\n"${body.trim()}" does not match any student record.\nPlease check and try again.\n\n  🎓 _(e.g. ADM/2025/001)_\n\n_*0* back · *6* menu_`,
      nextStep: 'ask_results_adm',
      sessionData: data
    }
  }
  const cls = student.classes
    ? `${student.classes.name}${student.classes.stream ? ' ' + student.classes.stream : ''}`
    : ''
  return await buildPeriodPicker(student.id, {
    ...data,
    results_student_name: `${student.first_name} ${student.last_name}`,
    results_student_class: cls
  })
}

// Shows available years & terms for the student to pick from
async function buildPeriodPicker(studentId, data) {
  try {
    const { data: available } = await supabase.from('student_results')
      .select('year, term')
      .eq('student_id', studentId)
      .order('year', { ascending: false })
      .order('term')

    if (!available || available.length === 0) {
      return {
        text: `📊 *Academic Results*\n━━━━━━━━━━━━━━━━━━━━\n\n  👤 *${data.results_student_name || 'Student'}*\n\nNo results have been recorded yet.\nResults are uploaded by teachers after each examination.\n\n_Type *balance* for fees · *hi* for menu_`,
        nextStep: 'welcome',
        sessionData: { student_id: studentId }
      }
    }

    // Build unique year+term periods
    const seen = new Set()
    const periods = []
    available.forEach(r => {
      const key = `${r.year}-${r.term}`
      if (!seen.has(key)) { seen.add(key); periods.push({ year: r.year, term: r.term }) }
    })

    const name = data.results_student_name || 'Student'
    const cls  = data.results_student_class ? `  🏫 ${data.results_student_class}\n` : ''

    let msg = `📊 *Academic Results*\n━━━━━━━━━━━━━━━━━━━━\n\n`
    msg += `  👤 *${name}*\n${cls}\n`
    msg += `Select the period you want to view:\n\n`
    periods.forEach((p, i) => {
      msg += `  *${i + 1}.* Year *${p.year}* — Term *${p.term}*\n`
    })
    msg += `  *${periods.length + 1}.* All years & terms\n`
    msg += `\n━━━━━━━━━━━━━━━━━━━━\n`
    msg += `_Type a number · *0* back · *6* menu_`

    return {
      text: msg,
      nextStep: 'pick_results_period',
      sessionData: { ...data, results_student_id: studentId, results_periods: periods }
    }
  } catch (err) {
    console.error('buildPeriodPicker error:', err.message)
    return { text: `❌ Could not load results. Type *results* to retry.`, nextStep: 'welcome', sessionData: {} }
  }
}

async function handleResultsPeriod(data, body) {
  const periods = data.results_periods || []
  const studentId = data.results_student_id || data.student_id
  const input = body.trim()

  // All years & terms
  if (parseInt(input) === periods.length + 1 || input.toUpperCase() === 'ALL') {
    return await fetchResults(studentId, null, null, data)
  }

  const idx = parseInt(input) - 1
  if (isNaN(idx) || idx < 0 || idx >= periods.length) {
    return {
      text: `❌ Please type a number between *1 and ${periods.length + 1}*.\n\n_*0* back · *6* menu_`,
      nextStep: 'pick_results_period',
      sessionData: data
    }
  }

  const period = periods[idx]
  return await fetchResults(studentId, period.year, period.term, data)
}

async function fetchResults(studentId, filterYear = null, filterTerm = null, sessionData = {}) {
  try {
    const { data: student } = await supabase.from('students')
      .select('first_name, last_name, classes(name, stream)').eq('id', studentId).single()

    let query = supabase.from('student_results')
      .select('subject, exam_type, marks_scored, total_marks, term, year')
      .eq('student_id', studentId)
      .order('year', { ascending: false })
      .order('term')
      .order('subject')
      .order('exam_type')

    if (filterYear)  query = query.eq('year', filterYear)
    if (filterTerm)  query = query.eq('term', filterTerm)

    const { data: results } = await query

    const cls = student?.classes
      ? `${student.classes.name}${student.classes.stream ? ' ' + student.classes.stream : ''}`
      : ''
    const name = `${student?.first_name} ${student?.last_name}`

    const periodLabel = filterYear
      ? (filterTerm ? `${filterYear} — Term ${filterTerm}` : `Year ${filterYear} (All Terms)`)
      : 'All Years'

    if (!results || results.length === 0) {
      return {
        text: `📊 *Academic Results — ${periodLabel}*\n━━━━━━━━━━━━━━━━━━━━\n\n  👤 *${name}*${cls ? `\n  🏫 ${cls}` : ''}\n\n━━━━━━━━━━━━━━━━━━━━\nNo results found for *${periodLabel}*.\n\n_Type *results* to pick a different period · *hi* for menu_`,
        nextStep: 'welcome',
        sessionData: { student_id: studentId }
      }
    }

    // Group by year → term → subject → exams
    const byYear = {}
    results.forEach(r => {
      if (!byYear[r.year]) byYear[r.year] = {}
      const tk = `Term ${r.term}`
      if (!byYear[r.year][tk]) byYear[r.year][tk] = {}
      if (!byYear[r.year][tk][r.subject]) byYear[r.year][tk][r.subject] = []
      byYear[r.year][tk][r.subject].push(r)
    })

    let msg = `📊 *Academic Results — ${periodLabel}*\n`
    msg += `━━━━━━━━━━━━━━━━━━━━\n\n`
    msg += `  👤 *${name}*\n`
    if (cls) msg += `  🏫 ${cls}\n`
    const allPcts = []

    Object.entries(byYear).sort((a, b) => b[0] - a[0]).forEach(([year, terms]) => {
      if (!filterYear) {
        msg += `\n━━━━━━━━━━━━━━━━━━━━\n`
        msg += `📅 *Year ${year}*\n`
      }
      Object.entries(terms).sort().forEach(([termLabel, subjects]) => {
        msg += `\n━━━━━━━━━━━━━━━━━━━━\n`
        msg += filterYear ? `📅 *${termLabel}*\n` : `  📅 *${termLabel}*\n`

        Object.entries(subjects).sort().forEach(([subject, exams]) => {
          msg += `\n  📚 *${subject}*\n`
          let subSum = 0, subCount = 0
          exams.forEach(e => {
            const pct = Math.round((e.marks_scored / e.total_marks) * 100)
            const gr = gradeLabel(pct)
            const label = EXAM_LABELS[e.exam_type] || e.exam_type
            const padLabel = label.padEnd(12, ' ')
            msg += `    ${padLabel} ${e.marks_scored}/${e.total_marks}  →  *${pct}%  ${gr}*\n`
            subSum += pct; subCount++; allPcts.push(pct)
          })
          if (subCount > 1) {
            const avg = Math.round(subSum / subCount)
            msg += `    _Subject Avg: ${avg}% — ${gradeLabel(avg)} (${gradeRemark(avg)})_\n`
          }
        })
      })
    })

    if (allPcts.length > 0) {
      const overall = Math.round(allPcts.reduce((a, b) => a + b, 0) / allPcts.length)
      const og = gradeLabel(overall)
      msg += `\n━━━━━━━━━━━━━━━━━━━━\n`
      msg += `📈 *Overall Average: ${overall}% — Grade ${og}*\n`
      msg += `_${gradeRemark(overall)}_\n`
      msg += `━━━━━━━━━━━━━━━━━━━━`
    }

    msg += `\n\n_Type *results* to view another period · *balance* for fees · *hi* for menu_`

    return {
      text: msg,
      nextStep: 'welcome',
      sessionData: { student_id: studentId }
    }
  } catch (err) {
    console.error('fetchResults error:', err.message)
    return {
      text: `❌ Could not load results. Type *results* to retry or *hi* for menu.`,
      nextStep: 'welcome',
      sessionData: {}
    }
  }
}

// ============================================================
// STEP HANDLERS
// ============================================================
async function showBalance(data, phone) {
  const studentId = data.student_id
  if (!studentId) {
    return {
      text: `📊 *Check Balance*\n\nEnter the student's *Admission Number*:\n_(e.g. ADM/2025/001)_\n\n_*6* for main menu_`,
      nextStep: 'ask_admission', sessionData: data
    }
  }
  try {
    const { data: student } = await supabase.from('students').select('*, classes(name, stream)').eq('id', studentId).single()
    const { data: allFees } = await supabase.from('v_student_fee_summary').select('*').eq('student_id', studentId).order('fee_category')
    const outstanding = (allFees || []).filter(f => Number(f.balance) > 0)
    const cleared = (allFees || []).filter(f => Number(f.balance) <= 0)
    const cls = student?.classes ? `${student.classes.name}${student.classes.stream ? ' ' + student.classes.stream : ''}` : 'N/A'

    let msg = `📊 *Fee Balance Statement*\n━━━━━━━━━━━━━━━━━━━━\n\n`
    msg += `👤 *${student?.first_name} ${student?.last_name}*\n`
    msg += `🏫 ${cls}\n\n`
    msg += `━━━━━━━━━━━━━━━━━━━━\n`
    if (outstanding.length === 0) {
      msg += `✅ *All Fees Cleared!*\n\nThis student has no outstanding balance.\nThank you for keeping up with payments! 🎉`
    } else {
      const totalOwed = outstanding.reduce((s, f) => s + Number(f.balance), 0)
      msg += `⚠️ *Outstanding Fees*\n\n`
      outstanding.forEach((f, i) => {
        msg += `  *${i + 1}.* ${f.fee_name}\n`
        msg += `       *KES ${Number(f.balance).toLocaleString()}*`
        if (f.due_date) {
          const due = new Date(f.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
          msg += ` — _due ${due}_`
        }
        msg += `\n\n`
      })
      msg += `━━━━━━━━━━━━━━━━━━━━\n`
      msg += `💰 *Total Remaining: KES ${totalOwed.toLocaleString()}*\n`
      if (cleared.length > 0) {
        msg += `\n✅ *Cleared (${cleared.length}):* `
        msg += cleared.map(f => f.fee_name).join(', ')
      }
      msg += `\n━━━━━━━━━━━━━━━━━━━━\n\n`
      msg += `_Type *hi* to pay now · *balance* to refresh_`
    }
    return { text: msg, nextStep: 'welcome', sessionData: { student_id: studentId } }
  } catch (err) {
    console.error('showBalance error:', err.message)
    return { text: `❌ Could not load balance. Type *balance* to retry or *hi* to pay.`, nextStep: 'welcome', sessionData: {} }
  }
}

function welcome() {
  return {
    text: `🏫 *SchoolPay — School Fee Payment*\n━━━━━━━━━━━━━━━━━━━━\n\nHello! 👋 Welcome to SchoolPay.\n\nTo get started, please enter your *email address*.\nThis is where we will send your payment receipt.\n\n  📧 _(e.g. parent@gmail.com)_\n\n━━━━━━━━━━━━━━━━━━━━\n_Quick commands: *balance* · *results* · *0* back · *6* menu_`,
    nextStep: 'ask_email', sessionData: {}
  }
}

function askEmail(data, body) {
  const email = body.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return {
      text: `❌ *Invalid Email Address*\n\nThe email you entered doesn't appear to be valid.\nPlease try again.\n\n  📧 _(e.g. parent@gmail.com)_\n\n_*6* for main menu_`,
      nextStep: 'ask_email', sessionData: {}
    }
  }
  return {
    text: `✅ *Email Saved!*\n\n  📧 ${email}\n\nNow please enter the student's *Admission Number*.\n\n  🎓 _(e.g. ADM/2025/001)_\n\n_*0* back · *6* menu_`,
    nextStep: 'ask_admission', sessionData: { email }
  }
}

async function askAdmission(data, body) {
  let student = null
  try {
    const { data: s } = await supabase.from('students').select('*, classes(name, stream)')
      .eq('school_id', SCHOOL_ID).ilike('admission_number', body.trim()).eq('is_active', true).single()
    student = s
  } catch (e) {}

  if (!student) {
    return {
      text: `❌ *Student Not Found*\n\n"${body.trim()}" does not match any student record.\n\nPlease check the admission number and try again.\n\n  🎓 _(e.g. ADM/2025/001)_\n\n_*0* back · *6* menu_`,
      nextStep: 'ask_admission', sessionData: data
    }
  }

  const { data: allFees } = await supabase.from('v_student_fee_summary').select('*').eq('student_id', student.id).order('fee_category')
  const outstanding = (allFees || []).filter(f => Number(f.balance) > 0)
  const cls = student.classes ? `${student.classes.name}${student.classes.stream ? ' ' + student.classes.stream : ''}` : 'N/A'

  if (!outstanding.length) {
    return {
      text: `✅ *All Fees Cleared!*\n━━━━━━━━━━━━━━━━━━━━\n\n  👤 *${student.first_name} ${student.last_name}*\n  🏫 ${cls}\n\nThis student has no outstanding fees.\nThank you for keeping up with payments! 🎉\n\n_Type *balance* to check · *hi* to start again_`,
      nextStep: 'welcome', sessionData: {}
    }
  }

  const total = outstanding.reduce((s, f) => s + Number(f.balance), 0)
  let msg = `📋 *Outstanding Fees*\n━━━━━━━━━━━━━━━━━━━━\n\n`
  msg += `  👤 *${student.first_name} ${student.last_name}*\n`
  msg += `  🏫 ${cls}  ·  ${student.admission_number}\n\n`
  outstanding.forEach((f, i) => {
    msg += `  *${i + 1}.* ${f.fee_name}\n`
    msg += `       *KES ${Number(f.balance).toLocaleString()}*\n\n`
  })
  msg += `━━━━━━━━━━━━━━━━━━━━\n`
  msg += `💰 *Total Due: KES ${total.toLocaleString()}*\n`
  msg += `━━━━━━━━━━━━━━━━━━━━\n\n`
  msg += `Reply with:\n`
  msg += `  • A *number* to pay one fee _(e.g. 1)_\n`
  msg += `  • *1,2* or *1,3* to pay multiple fees\n`
  msg += `  • *ALL* to pay everything at once\n\n`
  msg += `_*0* back · *6* menu_`

  return {
    text: msg, nextStep: 'show_fees',
    sessionData: {
      email: data.email, student_id: student.id,
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
  let selected = [], total = 0, label = ''

  if (input === 'ALL') {
    selected = fees
    total = fees.reduce((s, f) => s + Number(f.balance), 0)
    label = 'All Outstanding Fees'
  } else {
    // Parse single or multi-select: "1", "1,2", "1 2", "1,2,3", "1, 3"
    const nums = input.split(/[,\s]+/).map(n => n.trim()).filter(n => /^\d+$/.test(n))

    if (nums.length === 0) {
      return {
        text: `❌ Invalid. Type a *number (1–${fees.length})*, multiple *(e.g. 1,2 or 1,2,3)*, or *ALL*.\n_*0* back | *6* menu_`,
        nextStep: 'show_fees', sessionData: data
      }
    }

    const indices = [...new Set(nums.map(n => parseInt(n) - 1))]
    const invalid = indices.filter(i => i < 0 || i >= fees.length)

    if (invalid.length > 0) {
      return {
        text: `❌ Fee numbers must be between *1 and ${fees.length}*. Try again.\n_*0* back | *6* menu_`,
        nextStep: 'show_fees', sessionData: data
      }
    }

    selected = indices.map(i => fees[i])
    total = selected.reduce((s, f) => s + Number(f.balance), 0)
    label = selected.length === 1
      ? selected[0].fee_name
      : selected.map(f => f.fee_name).join(' + ')
  }

  return {
    text: `💳 *Payment Summary*\n━━━━━━━━━━━━━━━━━━━━\n\n  👤 *${data.student_name}*\n  📋 ${label}\n  💰 *KES ${total.toLocaleString()}*\n\n━━━━━━━━━━━━━━━━━━━━\n*Select Payment Method:*\n\n  *1* 📱  M-Pesa STK Push\n  *2* 💳  Card _(Visa / Mastercard)_\n  *3* 🏦  Bank Transfer\n\n━━━━━━━━━━━━━━━━━━━━\n_*0* back · *6* menu_`,
    nextStep: 'choose_method',
    sessionData: { ...data, selected_fees: selected, total_amount: total, fee_label: label }
  }
}

function chooseMethod(data, body) {
  const c = body.trim()
  if (!['1', '2', '3'].includes(c)) {
    return {
      text: `Please select a valid option:\n\n  *1* 📱  M-Pesa\n  *2* 💳  Card\n  *3* 🏦  Bank Transfer\n\n_*0* back · *6* menu_`,
      nextStep: 'choose_method', sessionData: data
    }
  }
  if (c === '1') {
    return {
      text: `📱 *M-Pesa Payment*\n━━━━━━━━━━━━━━━━━━━━\n\n  💰 Amount: *KES ${Number(data.total_amount).toLocaleString()}*\n  📋 ${data.fee_label}\n\nEnter the *M-Pesa phone number* that will receive the payment prompt:\n\n  📲 Accepted formats:\n  • 0712 345 678\n  • 254712345678\n  • +254712345678\n\n━━━━━━━━━━━━━━━━━━━━\n_*0* back · *6* menu_`,
      nextStep: 'ask_mpesa_phone', sessionData: data
    }
  }
  if (c === '2') {
    return {
      text: `💳 *Card Payment — Step 1 of 3*\n━━━━━━━━━━━━━━━━━━━━\n\n  💰 Amount: *KES ${Number(data.total_amount).toLocaleString()}*\n\nPlease enter your *16-digit card number*.\n\n  _(No spaces — e.g. 4111 1111 1111 1111)_\n\n🔒 _Secured and encrypted by Paystack_\n\n━━━━━━━━━━━━━━━━━━━━\n_*0* back · *6* menu_`,
      nextStep: 'card_number', sessionData: data
    }
  }
  if (c === '3') {
    const ref = generateRef()
    savePending(data, ref, 'bank').catch(console.error)
    return {
      text: `🏦 *Bank Transfer Details*\n━━━━━━━━━━━━━━━━━━━━\n\n  👤 ${data.student_name}\n  📋 ${data.fee_label}\n  💰 *KES ${Number(data.total_amount).toLocaleString()}*\n\n━━━━━━━━━━━━━━━━━━━━\n  🏦 Bank:    *Equity Bank*\n  📝 Account: *0123456789*\n  🏷️  Name:    *Sunshine Academy*\n  🔑 Ref:     *${ref}*\n━━━━━━━━━━━━━━━━━━━━\n\nUse *${ref}* as your payment reference when making the transfer.\n\n_Type *hi* to return to the main menu_`,
      nextStep: 'welcome', sessionData: {}
    }
  }
}

async function doMpesa(data, body, phone) {
  const raw = body.trim()
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 9 || digits.length > 12) {
    return {
      text: `❌ *Invalid Phone Number*\n\nThe number you entered is not valid.\nPlease enter a valid M-Pesa number:\n\n  • *0712345678*\n  • *254712345678*\n\n_*0* back · *6* menu_`,
      nextStep: 'ask_mpesa_phone', sessionData: data
    }
  }

  const paystackPhone = toPaystackPhone(raw)
  const ref = generateRef()
  console.log(`[MPESA] Charging ${paystackPhone} KES ${data.total_amount} ref:${ref}`)

  try {
    const res = await axios.post('https://api.paystack.co/charge', {
      email: data.email,
      amount: Math.round(Number(data.total_amount) * 100),
      currency: 'KES', reference: ref,
      mobile_money: { phone: paystackPhone, provider: 'mpesa' },
      metadata: {
        school_id: SCHOOL_ID, student_id: data.student_id,
        student_name: data.student_name, guardian_name: data.guardian_name,
        fee_label: data.fee_label,
        fee_ids: (data.selected_fees || []).map(f => f.student_fee_id).join(','),
        guardian_phone: phone, channel: 'whatsapp_mpesa'
      }
    }, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' } })

    const result = res.data
    if (result.status === false) throw new Error(result.message || 'Paystack rejected request')

    const status = result.data?.status
    const displayText = result.data?.display_text || ''
    await savePending(data, ref, 'mpesa')

    if (status === 'success') {
      await confirmAndUpdate(ref, data)
      const successMsg = await buildSuccessMessage(
        data.student_id, data.total_amount, data.fee_label,
        ref, data.email, data.guardian_name, data.student_name
      )
      return { text: successMsg, nextStep: 'welcome', sessionData: {} }
    }

    return {
      text: `📱 *M-Pesa — Payment Prompt Sent!*\n━━━━━━━━━━━━━━━━━━━━\n\n✅ A payment request has been sent to:\n   📲 *${paystackPhone}*\n\nPlease *enter your M-Pesa PIN* when the prompt appears on your phone.\n\n  💰 Amount: *KES ${Number(data.total_amount).toLocaleString()}*\n  📋 ${data.fee_label}\n  🔑 Ref: \`${ref}\`\n${displayText ? `\n  _${displayText}_\n` : ''}\n━━━━━━━━━━━━━━━━━━━━\n⏳ You have *60 seconds* to complete this.\n\n_Once confirmed, you will automatically receive a receipt with your remaining balance here._`,
      nextStep: 'welcome', sessionData: { waiting_ref: ref, guardian_phone: phone }
    }
  } catch (err) {
    const msg = err.response?.data?.message || err.message || 'Unknown error'
    console.error('[MPESA] Error:', msg)
    return {
      text: `❌ *M-Pesa Payment Failed*\n━━━━━━━━━━━━━━━━━━━━\n\n_${msg}_\n\n*What to check:*\n  • Ensure M-Pesa is activated on the number\n  • Use format: *0712345678*\n  • Ensure you have sufficient balance\n\n━━━━━━━━━━━━━━━━━━━━\n  *1* → Retry M-Pesa\n  *2* → Pay by Card\n\n_*0* back · *6* menu_`,
      nextStep: 'choose_method', sessionData: data
    }
  }
}

function cardNumber(data, body) {
  const n = body.replace(/\s/g, '')
  if (!/^\d{16}$/.test(n)) {
    return {
      text: `❌ *Invalid Card Number*\n\nPlease enter all *16 digits* of your card number without spaces.\n\n  _(e.g. 4111 1111 1111 1111)_\n\n_*0* back · *6* menu_`,
      nextStep: 'card_number', sessionData: data
    }
  }
  return {
    text: `✅ *Card Number Saved*\n\n💳 *Step 2 of 3* — Enter your card *Expiry Date*:\n\n  _(MM/YY — e.g. 12/26)_\n\n_*0* back · *6* menu_`,
    nextStep: 'card_expiry', sessionData: { ...data, card_number: n }
  }
}

function cardExpiry(data, body) {
  if (!/^\d{2}\/\d{2}$/.test(body.trim())) {
    return {
      text: `❌ *Invalid Expiry Date*\n\nPlease enter the date in MM/YY format.\n\n  _(e.g. 12/26)_\n\n_*0* back · *6* menu_`,
      nextStep: 'card_expiry', sessionData: data
    }
  }
  return {
    text: `✅ Expiry saved.\n\n*Step 3 of 3* — Enter your *CVV*:\n_(3-digit code on back of card)_\n\n_*0* back | *6* menu_`,
    nextStep: 'card_cvv', sessionData: { ...data, card_expiry: body.trim() }
  }
}

async function cardCvv(data, body, phone) {
  if (!/^\d{3,4}$/.test(body.trim())) {
    return { text: `❌ Invalid CVV. Enter the *3-digit* code on the back of your card:\n_*0* back | *6* menu_`, nextStep: 'card_cvv', sessionData: data }
  }

  const [expMonth, expYear] = data.card_expiry.split('/')
  const ref = generateRef()
  await sendWA(phone, `⏳ *Processing your card payment...*\n\n💰 KES ${Number(data.total_amount).toLocaleString()} — Please wait...`)

  try {
    const res = await axios.post('https://api.paystack.co/charge', {
      email: data.email,
      amount: Math.round(Number(data.total_amount) * 100),
      reference: ref, currency: 'KES',
      card: { number: data.card_number, cvv: body.trim(), expiry_month: expMonth, expiry_year: '20' + expYear },
      metadata: {
        school_id: SCHOOL_ID, student_id: data.student_id,
        student_name: data.student_name, guardian_name: data.guardian_name,
        fee_label: data.fee_label,
        fee_ids: (data.selected_fees || []).map(f => f.student_fee_id).join(','),
        guardian_phone: phone, channel: 'whatsapp_card'
      }
    }, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' } })

    const status = res.data?.data?.status
    await savePending(data, ref, 'card')

    if (status === 'success') {
      await confirmAndUpdate(ref, data)
      const successMsg = await buildSuccessMessage(
        data.student_id, data.total_amount, data.fee_label,
        ref, data.email, data.guardian_name, data.student_name
      )
      return { text: successMsg, nextStep: 'welcome', sessionData: {} }
    }

    return {
      text: `⏳ *Payment Being Processed*\n━━━━━━━━━━━━━━━━━━━━\n\n  🔑 Reference: \`${ref}\`\n\nYour payment is being verified. Please wait a moment.\n\nYou will automatically receive a confirmation receipt here once it is approved.\n\n_Type *6* for main menu_`,
      nextStep: 'welcome', sessionData: {}
    }
  } catch (err) {
    const msg = err.response?.data?.message || 'Card declined'
    console.error('[CARD] Error:', msg)
    return {
      text: `❌ *Card Payment Failed*\n━━━━━━━━━━━━━━━━━━━━\n\n_${msg}_\n\nPlease try again or use a different payment method.\n\n  *1* → Try M-Pesa instead\n  *2* → Retry with card\n\n_*0* back · *6* menu_`,
      nextStep: 'choose_method', sessionData: { ...data, card_number: undefined, card_expiry: undefined }
    }
  }
}

// ============================================================
// PAYSTACK WEBHOOK
// ============================================================
app.post('/webhook/paystack-confirm', async (req, res) => {
  try {
    const hash = crypto.createHmac('sha512', PAYSTACK_SECRET).update(JSON.stringify(req.body)).digest('hex')
    if (hash !== req.headers['x-paystack-signature']) return res.status(400).send('Bad signature')

    const event = req.body
    console.log('[WEBHOOK]', event.event, event.data?.reference)

    if (event.event === 'charge.success') {
      const { reference, amount, metadata, customer } = event.data
      const paid = amount / 100

      await supabase.from('payments')
        .update({ status: 'success', paystack_transaction_id: event.data.id, updated_at: new Date().toISOString() })
        .eq('paystack_reference', reference)

      const { data: pmts } = await supabase.from('payments').select('student_fee_id, amount').eq('paystack_reference', reference)
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

      const rawPhone = metadata?.guardian_phone
      const channel = metadata?.channel || ''

      if (rawPhone && metadata?.student_id) {
        const confirmMsg = await buildSuccessMessage(
          metadata.student_id, paid, metadata.fee_label || 'School Fees',
          reference, customer.email, metadata.guardian_name || 'Guardian', metadata.student_name || 'Student'
        )
        if (channel.includes('ussd')) {
          await sendSMS(rawPhone, confirmMsg.replace(/\*/g, '').replace(/_/g, ''))
        } else {
          await sendWA(rawPhone, confirmMsg)
        }
      }
    }
  } catch (err) {
    console.error('[WEBHOOK] Error:', err.message)
  }
  res.sendStatus(200)
})

// ============================================================
// DASHBOARD API — Single reminder
// ============================================================
app.post('/api/send-reminder', async (req, res) => {
  const { student_id } = req.body
  if (!student_id) return res.status(400).json({ error: 'student_id required' })
  try {
    const { data: student } = await supabase.from('students').select('*, classes(name, stream)').eq('id', student_id).single()
    if (!student) return res.status(404).json({ error: 'Student not found' })

    const { data: fees } = await supabase.from('v_student_fee_summary').select('*').eq('student_id', student_id).gt('balance', 0)
    if (!fees || fees.length === 0) return res.json({ success: true, message: 'No outstanding fees' })

    const total = fees.reduce((s, f) => s + Number(f.balance), 0)
    const cls = student.classes ? `${student.classes.name}${student.classes.stream ? ' ' + student.classes.stream : ''}` : ''

    let lines = ''
    fees.forEach(f => {
      lines += `\n• ${f.fee_name}: *KES ${Number(f.balance).toLocaleString()}*`
      if (f.due_date) {
        const due = new Date(f.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
        lines += ` _(due ${due})_`
      }
    })

    const rawPhone = student.guardian1_whatsapp || student.guardian1_phone
    if (!rawPhone) return res.status(400).json({ error: 'No phone number for guardian' })

    const msg = `🔔 *Payment Reminder*\n\nDear *${student.guardian1_name}*,\n\nOutstanding fees for *${student.first_name} ${student.last_name}* (${cls}):${lines}\n\n💰 *Total: KES ${total.toLocaleString()}*\n\nWhatsApp *hi* to pay or *balance* to check fees 😊\n\n🙏 Thank you!`

    if (student.guardian1_whatsapp) {
      await sendWA(student.guardian1_whatsapp, msg)
    } else {
      await sendSMS(rawPhone, msg.replace(/\*/g, '').replace(/_/g, ''))
    }

    res.json({ success: true, sent_to: toE164(rawPhone), student: `${student.first_name} ${student.last_name}`, total })
  } catch (err) {
    console.error('[REMINDER] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// DASHBOARD API — Bulk reminders
// ============================================================
app.post('/api/send-reminders', async (req, res) => {
  try {
    const { data: allFees } = await supabase.from('v_student_fee_summary').select('*').gt('balance', 0)
    const byStudent = {}
    ;(allFees || []).forEach(f => {
      if (!byStudent[f.student_id]) byStudent[f.student_id] = { name: f.full_name, fees: [] }
      byStudent[f.student_id].fees.push(f)
    })

    let sent = 0, skipped = 0
    for (const [sid, sd] of Object.entries(byStudent)) {
      const { data: s } = await supabase.from('students')
        .select('guardian1_whatsapp, guardian1_phone, guardian1_name').eq('id', sid).single()
      const raw = s?.guardian1_whatsapp || s?.guardian1_phone
      if (!raw) { skipped++; continue }

      const lines = sd.fees.map(f => `• ${f.fee_name}: KES ${Number(f.balance).toLocaleString()}`).join('\n')
      const total = sd.fees.reduce((s, f) => s + Number(f.balance), 0)
      const msg = `🔔 *Payment Reminder*\n\nDear *${s.guardian1_name}*,\n\nOutstanding fees for *${sd.name}*:\n\n${lines}\n\n💰 *Total: KES ${total.toLocaleString()}*\n\nType *hi* to pay or *balance* to check fees 😊\n\n🙏 Thank you!`

      if (s.guardian1_whatsapp) {
        await sendWA(s.guardian1_whatsapp, msg)
      } else {
        await sendSMS(raw, msg.replace(/\*/g, '').replace(/_/g, ''))
      }
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
        school_id: SCHOOL_ID, student_id: data.student_id,
        student_fee_id: fee.student_fee_id, amount: Number(fee.balance),
        payment_method: method, paystack_reference: ref,
        paid_by_email: data.email, paid_by_name: data.guardian_name || 'Guardian', status: 'pending'
      })
    } catch (e) { console.error('savePending error:', e.message) }
  }
}

async function confirmAndUpdate(ref, data) {
  await supabase.from('payments').update({ status: 'success', updated_at: new Date().toISOString() }).eq('paystack_reference', ref)
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

async function getSession(phone) {
  try {
    const { data } = await supabase.from('whatsapp_sessions').select('*').eq('phone_number', phone).single()
    if (!data) {
      const { data: s } = await supabase.from('whatsapp_sessions')
        .insert({ phone_number: phone, current_step: 'welcome', session_data: {} }).select().single()
      return s || { phone_number: phone, current_step: 'welcome', session_data: {} }
    }
    if (data.last_activity && (Date.now() - new Date(data.last_activity)) > 30 * 60 * 1000) {
      await supabase.from('whatsapp_sessions').update({ current_step: 'welcome', session_data: {}, last_activity: new Date() }).eq('phone_number', phone)
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
  } catch (err) { console.error('updateSession error:', err.message) }
}

async function resetSession(phone) {
  try {
    await supabase.from('whatsapp_sessions').upsert(
      { phone_number: phone, current_step: 'welcome', session_data: {}, last_activity: new Date().toISOString() },
      { onConflict: 'phone_number' }
    )
  } catch (err) { console.error('resetSession error:', err.message) }
}

app.get('/health', (_, res) => res.json({
  status: 'ok', service: 'SchoolPay Bot',
  channels: ['WhatsApp (Twilio)', 'SMS (Africa\'s Talking)', 'USSD (Africa\'s Talking)'],
  time: new Date().toISOString()
}))

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`🚀 SchoolPay Bot running on port ${PORT}`))
