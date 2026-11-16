import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const payment = await prisma.payment.findFirst({
    orderBy: { createdAt: 'desc' },
  });

  if (!payment) {
    console.log('No payments found');
    return;
  }

  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      verificationStatus: 'VERIFIED',
      verifiedAt: new Date(),
    },
  });

  console.log(`Payment ${payment.id} marked as VERIFIED`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
