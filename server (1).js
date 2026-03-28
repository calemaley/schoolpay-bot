// ============================================================
// SCHOOLPAY WHATSAPP BOT - Node.js / Express
// Deploy to Railway, Render, or Fly.io
// ============================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- Clients ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const MessagingResponse = twilio.twiml.MessagingResponse;

const SCHOOL_ID = process.env.SCHOOL_ID;
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const BOT_NUMBER = `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;

// ============================================================
// WHATSAPP WEBHOOK
// ============================================================
app.post('/webhook/whatsapp', async (req, res) => {
  const from = req.body.From; // "whatsapp:+254XXXXXXXXX"
  const body = (req.body.Body || '').trim();
  const phone = from.replace('whatsapp:', '');

  try {
    // Get or create session
    let session = await getSession(phone);
    const reply = await processMessage(session, body, phone);

    // Send reply via Twilio
    const twiml = new MessagingResponse();
    twiml.message(reply.text);
    res.set('Content-Type', 'text/xml');
    res.send(twiml.toString());

    // Update session
    await updateSession(phone, reply.nextStep, reply.sessionData);
  } catch (err) {
    console.error('Webhook error:', err);
    const twiml = new MessagingResponse();
    twiml.message('❌ Something went wrong. Please try again or contact the school office.');
    res.set('Content-Type', 'text/xml');
    res.send(twiml.toString());
  }
});

// ============================================================
// MESSAGE PROCESSOR
// ============================================================
async function processMessage(session, body, phone) {
  const step = session.current_step;
  const lower = body.toLowerCase().trim();

  // Always allow restart
  if (['hi', 'hello', 'start', 'menu', 'restart', '0'].includes(lower)) {
    return welcomeMessage(phone);
  }

  switch (step) {
    case 'welcome':
      return welcomeMessage(phone);

    case 'ask_email':
      return handleEmail(session, body);

    case 'ask_admission':
      return handleAdmission(session, body);

    case 'show_fees':
      return handleFeeSelection(session, body);

    case 'confirm_payment':
      return handlePaymentConfirm(session, body);

    default:
      return welcomeMessage(phone);
  }
}

// ============================================================
// STEP HANDLERS
// ============================================================

function welcomeMessage(phone) {
  return {
    text: `👋 *Welcome to SchoolPay!*\n\nYour secure school fees payment assistant. 🏫\n\nTo get started, please enter your *email address* so we can send you a receipt after payment.\n\n_(Type your email below)_`,
    nextStep: 'ask_email',
    sessionData: {}
  };
}

async function handleEmail(session, body) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(body)) {
    return {
      text: `❌ That doesn't look like a valid email.\n\nPlease enter a valid email address:\n_(e.g. parent@gmail.com)_`,
      nextStep: 'ask_email',
      sessionData: session.session_data
    };
  }

  return {
    text: `✅ Great! Email saved.\n\nNow please enter the *Admission Number* of the student you are paying for:\n\n_(e.g. ADM/2024/001)_`,
    nextStep: 'ask_admission',
    sessionData: { email: body.toLowerCase() }
  };
}

async function handleAdmission(session, body) {
  // Find student
  const { data: student, error } = await supabase
    .from('students')
    .select(`
      *,
      classes(name, stream)
    `)
    .eq('school_id', SCHOOL_ID)
    .ilike('admission_number', body.trim())
    .eq('is_active', true)
    .single();

  if (error || !student) {
    return {
      text: `❌ No student found with admission number *${body.trim()}*.\n\nPlease double-check and try again, or contact the school office.\n\n_(Type the admission number)_`,
      nextStep: 'ask_admission',
      sessionData: session.session_data
    };
  }

  // Get student fees
  const fees = await getStudentFees(student.id);
  const className = student.classes
    ? `${student.classes.name}${student.classes.stream ? ' ' + student.classes.stream : ''}`
    : 'N/A';

  let feeList = '';
  let allClear = true;

  fees.forEach((fee, i) => {
    const balance = fee.amount_due - fee.amount_paid;
    const status = balance <= 0 ? '✅ CLEARED' : `⚠️ Bal: KES ${balance.toLocaleString()}`;
    feeList += `\n*${i + 1}.* ${fee.fee_name} - ${status}`;
    if (balance > 0) allClear = false;
  });

  if (allClear) {
    return {
      text: `✅ *All fees cleared!*\n\n👤 *${student.first_name} ${student.last_name}*\n🏫 Class: ${className}\n📋 Admission: ${student.admission_number}\n\nAll fees are fully paid. Thank you for your promptness! 🎉\n\nType *hi* to start again.`,
      nextStep: 'welcome',
      sessionData: {}
    };
  }

  const sessionData = {
    ...session.session_data,
    student_id: student.id,
    student_name: `${student.first_name} ${student.last_name}`,
    fees: fees
  };

  return {
    text: `👤 *${student.first_name} ${student.last_name}*\n🏫 Class: ${className}\n📋 Admission: ${student.admission_number}\n\n*📊 Fee Statement:*${feeList}\n\n─────────────────\nType the *number* of the fee you'd like to pay, or type *0* to go back to menu.`,
    nextStep: 'show_fees',
    sessionData
  };
}

async function handleFeeSelection(session, body) {
  const fees = session.session_data.fees;
  const choice = parseInt(body.trim()) - 1;

  if (isNaN(choice) || choice < 0 || choice >= fees.length) {
    return {
      text: `❌ Invalid choice. Please enter a number between 1 and ${fees.length}, or type *0* for the main menu.`,
      nextStep: 'show_fees',
      sessionData: session.session_data
    };
  }

  const selected = fees[choice];
  const balance = selected.amount_due - selected.amount_paid;

  if (balance <= 0) {
    return {
      text: `✅ *${selected.fee_name}* is already fully paid!\n\nType a number to pay another fee, or *0* for the main menu.`,
      nextStep: 'show_fees',
      sessionData: session.session_data
    };
  }

  const sessionData = {
    ...session.session_data,
    selected_fee: selected,
    balance: balance
  };

  return {
    text: `💳 *${selected.fee_name}*\n\nBalance Due: *KES ${balance.toLocaleString()}*\n\nChoose payment method:\n*1.* 📱 M-Pesa (STK Push)\n*2.* 💳 Card / Bank Transfer\n\n_(Type 1 or 2)_`,
    nextStep: 'confirm_payment',
    sessionData
  };
}

async function handlePaymentConfirm(session, body) {
  const choice = body.trim();
  const { student_id, student_name, selected_fee, balance, email } = session.session_data;

  if (!['1', '2'].includes(choice)) {
    return {
      text: `Please type *1* for M-Pesa or *2* for Card/Bank Transfer.`,
      nextStep: 'confirm_payment',
      sessionData: session.session_data
    };
  }

  // Generate Paystack payment link
  const reference = `SCH-${Date.now()}-${Math.random().toString(36).substr(2,6).toUpperCase()}`;
  const paystackChannel = choice === '1' ? 'mobile_money' : 'card';

  try {
    // Initialize Paystack transaction
    const paystackRes = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email: email,
        amount: Math.round(balance * 100), // kobo/pesewas
        reference,
        currency: 'KES',
        metadata: {
          student_id,
          student_name,
          fee_id: selected_fee.student_fee_id,
          fee_name: selected_fee.fee_name,
          school_id: SCHOOL_ID,
          cancel_action: process.env.PAYMENT_CANCEL_URL
        },
        channels: choice === '1' ? ['mobile_money'] : ['card', 'bank_transfer'],
        callback_url: `${process.env.BASE_URL}/webhook/paystack-confirm`,
        ...(choice === '1' && {
          mobile_money: { phone: session.phone_number, provider: 'mpesa' }
        })
      },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
    );

    const payLink = paystackRes.data.data.authorization_url;

    // Save pending payment to DB
    await supabase.from('payments').insert({
      school_id: SCHOOL_ID,
      student_id,
      student_fee_id: selected_fee.student_fee_id,
      amount: balance,
      payment_method: choice === '1' ? 'mpesa' : 'card',
      paystack_reference: reference,
      paid_by_email: email,
      paid_by_name: 'Guardian',
      status: 'pending'
    });

    const methodMsg = choice === '1'
      ? '📱 *M-Pesa STK Push*\n\nAn M-Pesa prompt will appear on your phone. Enter your PIN to complete payment.'
      : '💳 *Card / Bank Transfer*\n\nYou will be redirected to a secure payment page.';

    return {
      text: `${methodMsg}\n\n💰 Amount: *KES ${balance.toLocaleString()}*\n📋 For: *${selected_fee.fee_name}*\n👤 Student: *${student_name}*\n\n🔗 *Pay here:*\n${payLink}\n\n_Your receipt will be sent to ${email} after payment._\n\n⚠️ Please complete payment within 15 minutes.\n\nType *0* for main menu.`,
      nextStep: 'welcome',
      sessionData: {}
    };

  } catch (err) {
    console.error('Paystack error:', err.response?.data || err.message);
    return {
      text: `❌ Could not initiate payment. Please try again or contact the school office.\n\nType *0* for main menu.`,
      nextStep: 'welcome',
      sessionData: {}
    };
  }
}

// ============================================================
// PAYSTACK WEBHOOK (payment confirmation)
// ============================================================
app.post('/webhook/paystack-confirm', async (req, res) => {
  const crypto = require('crypto');
  const hash = crypto
    .createHmac('sha512', PAYSTACK_SECRET)
    .update(JSON.stringify(req.body))
    .digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
    return res.status(400).send('Invalid signature');
  }

  const event = req.body;

  if (event.event === 'charge.success') {
    const { reference, amount, metadata, customer } = event.data;
    const amountPaid = amount / 100;

    // Update payment record
    await supabase.from('payments')
      .update({
        status: 'success',
        paystack_transaction_id: event.data.id,
        mpesa_receipt: event.data.authorization?.sender_mobile_money_number,
        paid_by_email: customer.email,
        updated_at: new Date().toISOString()
      })
      .eq('paystack_reference', reference);

    // Update student_fees balance
    const { data: sf } = await supabase
      .from('student_fees')
      .select('*')
      .eq('id', metadata.fee_id)
      .single();

    if (sf) {
      const newPaid = parseFloat(sf.amount_paid) + amountPaid;
      const newStatus = newPaid >= sf.amount_due ? 'paid' : 'partial';
      await supabase.from('student_fees')
        .update({ amount_paid: newPaid, status: newStatus })
        .eq('id', metadata.fee_id);
    }

    // Get student's guardian WhatsApp number
    const { data: student } = await supabase
      .from('students')
      .select('*')
      .eq('id', metadata.student_id)
      .single();

    if (student?.guardian1_whatsapp || student?.guardian1_phone) {
      const guardianPhone = student.guardian1_whatsapp || student.guardian1_phone;
      await sendWhatsApp(
        guardianPhone,
        `✅ *Payment Confirmed!*\n\n🎉 Thank you! Payment received successfully.\n\n👤 Student: *${metadata.student_name}*\n💳 Fee: *${metadata.fee_name}*\n💰 Amount: *KES ${amountPaid.toLocaleString()}*\n📄 Reference: ${reference}\n\nA receipt has been sent to *${customer.email}*.\n\nThank you for investing in your child's education! 🎓`
      );
    }
  }

  res.sendStatus(200);
});

// ============================================================
// HELPERS
// ============================================================

async function getSession(phone) {
  const { data } = await supabase
    .from('whatsapp_sessions')
    .select('*')
    .eq('phone_number', phone)
    .single();

  if (!data) {
    const { data: newSession } = await supabase
      .from('whatsapp_sessions')
      .insert({ phone_number: phone, current_step: 'welcome' })
      .select()
      .single();
    return newSession;
  }

  // Expire sessions older than 30 minutes
  const lastActivity = new Date(data.last_activity);
  const now = new Date();
  if ((now - lastActivity) > 30 * 60 * 1000) {
    await supabase.from('whatsapp_sessions')
      .update({ current_step: 'welcome', session_data: {}, last_activity: now })
      .eq('phone_number', phone);
    return { ...data, current_step: 'welcome', session_data: {} };
  }

  return data;
}

async function updateSession(phone, step, sessionData) {
  await supabase.from('whatsapp_sessions')
    .upsert({
      phone_number: phone,
      current_step: step,
      session_data: sessionData || {},
      last_activity: new Date().toISOString()
    }, { onConflict: 'phone_number' });
}

async function getStudentFees(studentId) {
  const { data } = await supabase
    .from('v_student_fee_summary')
    .select('*')
    .eq('student_id', studentId)
    .order('fee_category');

  return data || [];
}

async function sendWhatsApp(phone, message) {
  try {
    // Normalize phone
    let normalized = phone.replace(/\s/g, '');
    if (normalized.startsWith('0')) normalized = '+254' + normalized.slice(1);
    if (!normalized.startsWith('+')) normalized = '+' + normalized;

    await twilioClient.messages.create({
      from: BOT_NUMBER,
      to: `whatsapp:${normalized}`,
      body: message
    });
  } catch (err) {
    console.error('WhatsApp send error:', err.message);
  }
}

// Send reminder to all students with outstanding balances
app.post('/api/send-reminders', async (req, res) => {
  const { apiKey } = req.body;
  if (apiKey !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: 'Unauthorized' });

  const { data: outstanding } = await supabase
    .from('v_student_fee_summary')
    .select('*')
    .gt('balance', 0)
    .neq('status', 'waived');

  // Group by student
  const byStudent = {};
  outstanding?.forEach(row => {
    if (!byStudent[row.student_id]) byStudent[row.student_id] = { name: row.full_name, fees: [] };
    byStudent[row.student_id].fees.push(row);
  });

  let sent = 0;
  for (const [studentId, data] of Object.entries(byStudent)) {
    const { data: student } = await supabase
      .from('students')
      .select('guardian1_whatsapp, guardian1_phone, guardian1_name')
      .eq('id', studentId)
      .single();

    const guardianPhone = student?.guardian1_whatsapp || student?.guardian1_phone;
    if (!guardianPhone) continue;

    const feeLines = data.fees
      .map(f => `• ${f.fee_name}: KES ${f.balance.toLocaleString()}`)
      .join('\n');

    const total = data.fees.reduce((s, f) => s + f.balance, 0);

    await sendWhatsApp(
      guardianPhone,
      `🔔 *Friendly Payment Reminder*\n\nDear ${student.guardian1_name},\n\nWe hope all is well! This is a gentle reminder that the following fees are outstanding for *${data.name}*:\n\n${feeLines}\n\n💰 *Total Due: KES ${total.toLocaleString()}*\n\nKindly clear these at your earliest convenience to avoid any inconvenience.\n\nTo pay now, simply message this number with *hi* and follow the easy steps.\n\nThank you for your continued support! 🙏\n\n_SchoolPay System_`
    );
    sent++;
    await new Promise(r => setTimeout(r, 500)); // rate limit
  }

  res.json({ success: true, reminders_sent: sent });
});

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'SchoolPay Bot' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 SchoolPay Bot running on port ${PORT}`));
