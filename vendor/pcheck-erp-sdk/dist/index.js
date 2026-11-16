"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PCheckSDK = exports.PCheckApiError = void 0;
class PCheckApiError extends Error {
    constructor(message, statusCode, responseBody) {
        super(message);
        this.statusCode = statusCode;
        this.responseBody = responseBody;
        this.name = 'PCheckApiError';
    }
}
exports.PCheckApiError = PCheckApiError;
class PCheckSDK {
    constructor(config) {
        this.config = {
            baseUrl: config.baseUrl.replace(/\/$/, ''),
            apiToken: config.apiToken,
            webhookSecret: config.webhookSecret || '',
            timeout: config.timeout || 10000,
            retries: config.retries || 3,
            retryDelay: config.retryDelay || 500,
        };
    }
    /**
     * Verify a payment synchronously
     */
    async verify(params) {
        const response = await this.request('POST', '/api/v1/verifications', {
            provider: params.provider,
            transaction_id: params.transactionId,
            amount: params.amount,
            currency: params.currency || 'ETB',
            recipient_phone: params.recipientPhone,
            metadata: params.metadata,
        });
        return response.data.attributes;
    }
    /**
     * Get a verification by ID
     */
    async getVerification(verificationId) {
        const response = await this.request('GET', `/api/v1/verifications/${verificationId}`);
        return response.data.attributes;
    }
    /**
     * List verifications with optional filters
     */
    async listVerifications(filters) {
        const queryString = filters ? '?' + new URLSearchParams(filters).toString() : '';
        const response = await this.request('GET', `/api/v1/verifications${queryString}`);
        return response;
    }
    /**
     * Create an async verification request with callback
     */
    async requestVerification(params) {
        const response = await this.request('POST', '/api/v1/verification-requests', {
            order_id: params.orderId,
            order_number: params.orderNumber,
            amount: params.amount,
            currency: params.currency,
            callback_url: params.callbackUrl,
            payment_id: params.paymentId,
            table_number: params.tableNumber,
        });
        return response.data.attributes;
    }
    /**
     * Get a verification request by ID
     */
    async getVerificationRequest(requestId) {
        const response = await this.request('GET', `/api/v1/verification-requests/${requestId}`);
        return response.data.attributes;
    }
    /**
     * Check API health
     */
    async health() {
        return await this.request('GET', '/api/health', null, false);
    }
    /**
     * Verify webhook signature
     */
    verifyWebhookSignature(payload, signature) {
        if (!this.config.webhookSecret) {
            throw new Error('Webhook secret not configured');
        }
        if (!signature.startsWith('sha256=')) {
            return false;
        }
        const expected = 'sha256=' + this.createHmac(payload, this.config.webhookSecret);
        return this.secureCompare(expected, signature);
    }
    /**
     * Parse and verify webhook payload
     */
    parseWebhook(payload, signature) {
        if (!this.verifyWebhookSignature(payload, signature)) {
            throw new Error('Invalid webhook signature');
        }
        return JSON.parse(payload);
    }
    /**
     * Make HTTP request to P-Check API
     */
    async request(method, endpoint, data, auth = true) {
        const url = `${this.config.baseUrl}${endpoint}`;
        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        };
        if (auth) {
            headers['Authorization'] = `Bearer ${this.config.apiToken}`;
        }
        let lastError = null;
        for (let attempt = 0; attempt <= this.config.retries; attempt++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);
                const response = await fetch(url, {
                    method,
                    headers,
                    body: data ? JSON.stringify(data) : undefined,
                    signal: controller.signal,
                });
                clearTimeout(timeoutId);
                if (!response.ok) {
                    const errorBody = await response.text();
                    let errorData;
                    try {
                        errorData = JSON.parse(errorBody);
                    }
                    catch {
                        errorData = errorBody;
                    }
                    throw new PCheckApiError(errorData?.error?.message || `HTTP ${response.status}`, response.status, errorData);
                }
                return await response.json();
            }
            catch (error) {
                lastError = error;
                if (attempt < this.config.retries) {
                    await this.sleep(this.config.retryDelay);
                    continue;
                }
                throw lastError;
            }
        }
        throw lastError || new Error('Request failed');
    }
    /**
     * Create HMAC-SHA256 signature
     */
    createHmac(data, secret) {
        // Node.js environment
        if (typeof require !== 'undefined') {
            const crypto = require('crypto');
            return crypto.createHmac('sha256', secret).update(data).digest('hex');
        }
        // Browser environment (Web Crypto API)
        throw new Error('HMAC verification requires Node.js environment');
    }
    /**
     * Secure string comparison to prevent timing attacks
     */
    secureCompare(a, b) {
        if (a.length !== b.length) {
            return false;
        }
        let result = 0;
        for (let i = 0; i < a.length; i++) {
            result |= a.charCodeAt(i) ^ b.charCodeAt(i);
        }
        return result === 0;
    }
    /**
     * Sleep for specified milliseconds
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
exports.PCheckSDK = PCheckSDK;
