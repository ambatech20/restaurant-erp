export interface PCheckConfig {
    baseUrl: string;
    apiToken: string;
    webhookSecret?: string;
    timeout?: number;
    retries?: number;
    retryDelay?: number;
}
export interface VerificationResult {
    id: string;
    status: 'pending' | 'verified' | 'not_found' | 'mismatch' | 'failed' | 'manual_review';
    provider: string;
    transaction_id: string;
    amount: number;
    currency: string;
    recipient_phone?: string;
    verified_amount?: number;
    verified_recipient?: string;
    verified_at?: string;
    metadata?: Record<string, any>;
    created_at: string;
    updated_at: string;
}
export interface VerificationRequest {
    id: string;
    status: 'pending' | 'completed';
    order_number: string;
    table_number?: string;
    amount: number;
    currency: string;
    callback_secret: string;
    created_at: string;
    completed_at?: string;
}
export interface WebhookPayload {
    event: string;
    timestamp: string;
    payment_id?: number;
    order_id?: number;
    data: VerificationResult;
}
export interface HealthStatus {
    status: string;
    version: string;
    timestamp: string;
    providers: Record<string, {
        label: string;
        available: boolean;
        mode: string;
        live_check?: boolean;
        error?: string;
    }>;
}
export declare class PCheckApiError extends Error {
    statusCode?: number | undefined;
    responseBody?: any | undefined;
    constructor(message: string, statusCode?: number | undefined, responseBody?: any | undefined);
}
export declare class PCheckSDK {
    private config;
    constructor(config: PCheckConfig);
    /**
     * Verify a payment synchronously
     */
    verify(params: {
        provider: string;
        transactionId: string;
        amount: number;
        currency?: string;
        recipientPhone?: string;
        metadata?: Record<string, any>;
    }): Promise<VerificationResult>;
    /**
     * Get a verification by ID
     */
    getVerification(verificationId: string): Promise<VerificationResult>;
    /**
     * List verifications with optional filters
     */
    listVerifications(filters?: {
        status?: string;
        provider?: string;
        sort?: string;
        order?: 'asc' | 'desc';
        limit?: number;
        page?: number;
    }): Promise<{
        data: VerificationResult[];
        meta: any;
    }>;
    /**
     * Create an async verification request with callback
     */
    requestVerification(params: {
        orderId: number;
        orderNumber: string;
        amount: number;
        currency: string;
        callbackUrl: string;
        paymentId: number;
        tableNumber?: string;
    }): Promise<VerificationRequest>;
    /**
     * Get a verification request by ID
     */
    getVerificationRequest(requestId: string): Promise<VerificationRequest>;
    /**
     * Check API health
     */
    health(): Promise<HealthStatus>;
    /**
     * Verify webhook signature
     */
    verifyWebhookSignature(payload: string, signature: string): boolean;
    /**
     * Parse and verify webhook payload
     */
    parseWebhook(payload: string, signature: string): WebhookPayload;
    /**
     * Make HTTP request to P-Check API
     */
    private request;
    /**
     * Create HMAC-SHA256 signature
     */
    private createHmac;
    /**
     * Secure string comparison to prevent timing attacks
     */
    private secureCompare;
    /**
     * Sleep for specified milliseconds
     */
    private sleep;
}
