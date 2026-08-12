'use strict';

class SnapServeApi {
  constructor({ apiKey, baseUrl }) {
    if (!apiKey) throw new Error('SNAPSERVE_API_KEY is required');
    this.apiKey = apiKey;
    this.baseUrl = String(baseUrl || 'https://app.snapserve.ai/api').replace(/\/$/, '');
  }

  async request(path, options = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers
      }
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
    if (!response.ok) {
      throw new Error(data.message || data.error || `SnapServe API returned ${response.status}`);
    }
    return data;
  }

  listAgents() {
    return this.request('/agents');
  }

  listCalls(limit = 100) {
    return this.request(`/calls?limit=${encodeURIComponent(limit)}`);
  }

  startOutboundCall({ phone, agentId, webhookBaseUrl, metadata }) {
    return this.request('/calls/outbound', {
      method: 'POST',
      body: JSON.stringify({
        agentId: !Number.isNaN(Number(agentId)) && agentId !== '' ? Number(agentId) : agentId,
        toNumber: phone,
        ...(webhookBaseUrl ? { webhookBaseUrl } : {}),
        ...(metadata ? { metadata } : {})
      })
    });
  }
}

module.exports = { SnapServeApi };
