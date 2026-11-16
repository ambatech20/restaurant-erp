# P-Check ERP SDK (TypeScript)

TypeScript SDK for integrating ERP systems with the P-Check payment verification API. Designed for Next.js, Node.js, and other JavaScript/TypeScript applications.

## Installation

```bash
npm install @eliabay100-del/pcheck-erp-sdk
# or
yarn add @eliabay100-del/pcheck-erp-sdk
# or
pnpm add @eliabay100-del/pcheck-erp-sdk
```

## Configuration

```typescript
import { PCheckSDK } from '@eliabay100-del/pcheck-erp-sdk';

const pcheck = new PCheckSDK({
  baseUrl: process.env.PCHECK_API_URL!,
  apiToken: process.env.PCHECK_API_TOKEN!,
  webhookSecret: process.env.PCHECK_WEBHOOK_SECRET,
  timeout: 10000, // 10 seconds
  retries: 3,
  retryDelay: 500, // milliseconds
});
```

## Usage

### Synchronous Verification

Verify a payment immediately:

```typescript
try {
  const result = await pcheck.verify({
    provider: 'telebirr',
    transactionId: 'TXN-20261021-001',
    amount: 150.00,
    currency: 'ETB',
    recipientPhone: '+251912345678',
    metadata: { orderId: 123 },
  });

  if (result.status === 'verified') {
    console.log('Payment confirmed!', result.verified_amount);
  } else if (result.status === 'mismatch') {
    console.log('Amount mismatch', {
      expected: result.amount,
      actual: result.verified_amount,
    });
  }
} catch (error) {
  if (error instanceof PCheckApiError) {
    console.error('API error:', error.message, error.statusCode);
  }
}
```

### Asynchronous Verification (with Callback)

For systems that need to be notified when verification completes:

```typescript
// Initiate verification request
const request = await pcheck.requestVerification({
  orderId: 100,
  orderNumber: 'ORD-001',
  amount: 250.00,
  currency: 'ETB',
  callbackUrl: 'https://your-app.com/api/webhooks/pcheck',
  paymentId: 42,
  tableNumber: 'T5',
});

// Store the callback_secret for later verification
console.log('Request ID:', request.id);
console.log('Callback Secret:', request.callback_secret);

// Save to your database
await db.payment.update({
  where: { id: 42 },
  data: {
    pcheckRequestId: request.id,
    pcheckCallbackSecret: request.callback_secret,
    status: 'pending_verification',
  },
});
```

### Handling Webhook Callbacks (Next.js API Route)

```typescript
// app/api/webhooks/pcheck/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { PCheckSDK } from '@eliabay100-del/pcheck-erp-sdk';

const pcheck = new PCheckSDK({
  baseUrl: process.env.PCHECK_API_URL!,
  apiToken: process.env.PCHECK_API_TOKEN!,
  webhookSecret: process.env.PCHECK_WEBHOOK_SECRET!,
});

export async function POST(request: NextRequest) {
  const payload = await request.text();
  const signature = request.headers.get('x-webhook-signature') || '';

  try {
    // Verify signature and parse payload
    const webhook = pcheck.parseWebhook(payload, signature);

    // Find your payment
    const payment = await db.payment.findUnique({
      where: { pcheckRequestId: webhook.data.id },
    });

    if (!payment) {
      return NextResponse.json(
        { error: 'Payment not found' },
        { status: 404 }
      );
    }

    // Update payment status
    if (webhook.data.status === 'verified') {
      await db.payment.update({
        where: { id: payment.id },
        data: {
          status: 'paid',
          verifiedAmount: webhook.data.verified_amount,
          paidAt: new Date(),
        },
      });

      // Trigger your business logic
      // await markOrderAsPaid(payment.orderId);
    } else {
      await db.payment2026-10-21 14:35:44 -0400