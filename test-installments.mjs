// Quick standalone check of the installment math (mirrors server.js logic)
const INSTALLMENT_TARGETS = [0.4, 0.8, 1.0]

function nextInstallment(fee) {
  const balance = Number(fee.balance)
  const due     = Number(fee.amount_due || balance)
  const paid    = fee.amount_paid != null ? Number(fee.amount_paid) : due - balance
  for (let i = 0; i < INSTALLMENT_TARGETS.length; i++) {
    const target = Math.round(due * INSTALLMENT_TARGETS[i])
    if (paid < target) {
      return { number: i + 1, amount: Math.min(target - paid, balance) }
    }
  }
  return null
}

const cases = [
  { name: 'Fresh fee 30,000',            fee: { amount_due: 30000, amount_paid: 0,     balance: 30000 }, expect: { number: 1, amount: 12000 } },
  { name: 'After 1st installment',       fee: { amount_due: 30000, amount_paid: 12000, balance: 18000 }, expect: { number: 2, amount: 12000 } },
  { name: 'After 2nd installment',       fee: { amount_due: 30000, amount_paid: 24000, balance: 6000 },  expect: { number: 3, amount: 6000 } },
  { name: 'Odd partial (paid 50%)',      fee: { amount_due: 30000, amount_paid: 15000, balance: 15000 }, expect: { number: 2, amount: 9000 } },
  { name: 'Nearly cleared (paid 95%)',   fee: { amount_due: 30000, amount_paid: 28500, balance: 1500 },  expect: { number: 3, amount: 1500 } },
  { name: 'Fully paid',                  fee: { amount_due: 30000, amount_paid: 30000, balance: 0 },     expect: null },
  { name: 'Odd amount 10,001 fresh',     fee: { amount_due: 10001, amount_paid: 0,     balance: 10001 }, expect: { number: 1, amount: 4000 } },
]

let fail = 0
for (const c of cases) {
  const got = nextInstallment(c.fee)
  const ok = JSON.stringify(got) === JSON.stringify(c.expect)
  if (!ok) fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}  → got ${JSON.stringify(got)} expected ${JSON.stringify(c.expect)}`)
}

// Sum-to-total check: three sequential installments must exactly clear an odd fee
let fee = { amount_due: 10001, amount_paid: 0, balance: 10001 }
let paidTotal = 0
for (let i = 0; i < 3; i++) {
  const ni = nextInstallment(fee)
  paidTotal += ni.amount
  fee = { ...fee, amount_paid: fee.amount_paid + ni.amount, balance: fee.balance - ni.amount }
}
const sumOk = paidTotal === 10001 && fee.balance === 0
if (!sumOk) fail++
console.log(`${sumOk ? 'PASS' : 'FAIL'}  3 installments exactly clear KES 10,001 (paid ${paidTotal}, balance ${fee.balance})`)

process.exit(fail ? 1 : 0)
