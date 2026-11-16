import { PrismaClient } from '@prisma/client';
import { processPayment } from '../src/features/payments/actions';

const prisma = new PrismaClient();

async function testMobilePayment() {
  console.log('Finding unpaid order...');
  
  // Find an unpaid order
  const order = await prisma.order.findFirst({
    where: {
      payment: null,
      status: { not: 'CANCELLED' },
    },
  });
  
  if (!order) {
    console.error('No unpaid orders found');
    await prisma.$disconnect();
    return;
  }
  
  console.log(`Using order: ${order.orderNumber} (ID: ${order.id}, Total: ${order.total})`);
  console.log('Processing mobile payment...');

  // Process payment with mobile method
  const result = await processPayment(
    order.id,
    'MOBILE',
    115,
    `TXN${Date.now()}` // Transaction reference
  );

  if (result.success) {
    console.log('Payment processed successfully!');
    console.log('Verification status:', result.payment.verificationStatus);
    console.log('Verified at:', result.payment.verifiedAt);
  } else {
    console.error('Payment failed:', result.error);
  }

  await prisma.$disconnect();
}

testMobilePayment().catch(console.error);
