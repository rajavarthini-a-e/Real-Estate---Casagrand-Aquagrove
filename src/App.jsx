import { useState, useEffect } from 'react';

function App() {
  // --- Simple SPA Router ---
  const [currentPath, setCurrentPath] = useState(window.location.pathname);

  useEffect(() => {
    const handleLocationChange = () => {
      setCurrentPath(window.location.pathname);
    };
    window.addEventListener('popstate', handleLocationChange);
    return () => window.removeEventListener('popstate', handleLocationChange);
  }, []);

  const navigate = (path) => {
    window.history.pushState({}, '', path);
    setCurrentPath(path);
  };

  // --- Lead & Call State Management ---
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // --- Selected Lead Drawer State ---
  const [selectedLeadId, setSelectedLeadId] = useState(null);
  const selectedLead = leads.find((l) => l.id === selectedLeadId);

  // --- SQLite Call Details State (Fetched dynamically on click) ---
  const [selectedCallDetails, setSelectedCallDetails] = useState(null);
  const [loadingCallDetails, setLoadingCallDetails] = useState(false);

  // Fetch call log details from SQLite table when a lead is selected
  useEffect(() => {
    if (selectedLead && selectedLead.snapserve_call_id) {
      setLoadingCallDetails(true);
      fetch(`/api/admin/calls/${selectedLead.snapserve_call_id}`)
        .then((res) => {
          if (!res.ok) throw new Error('Failed to fetch call details');
          return res.json();
        })
        .then((data) => {
          setSelectedCallDetails(data.call || null);
          setLoadingCallDetails(false);
        })
        .catch((err) => {
          console.error('[FRONTEND] Call details fetch failed:', err.message);
          setSelectedCallDetails(null);
          setLoadingCallDetails(false);
        });
    } else {
      setSelectedCallDetails(null);
    }
  }, [selectedLeadId, leads, selectedLead]);

  // --- Fetch Leads and Calls ---
  const fetchData = async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      // Fetch leads (which now left-joins database records directly)
      const leadsRes = await fetch('/api/admin/leads');
      if (!leadsRes.ok) throw new Error('Unable to retrieve SnapServe call data.');
      const leadsData = await leadsRes.json();
      setLeads(leadsData);
      setError(null);
    } catch (err) {
      console.error('Error fetching data:', err);
      setError(err.message);
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  // Fetch on load and set up auto-refresh every 10 seconds
  useEffect(() => {
    fetchData(true);
    const interval = setInterval(() => {
      fetchData(false);
    }, 10000); // 10 seconds auto-refresh

    return () => clearInterval(interval);
  }, [currentPath]);

  // --- Form Submission State ---
  const [formSubmitted, setFormSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  // --- Customer Lead Form Fields ---
  const [formData, setFormData] = useState({
    name: '',
    phone: '',
    email: '',
    location: '',
    lookingFor: 'Buy',
    propertyType: 'Apartment',
    bedrooms: '2 BHK',
    budget: '₹50–75 Lakhs',
    callbackTime: 'Evening',
  });

  const handleFormSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    
    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(formData),
      });

      const result = await res.json();

      if (!res.ok) {
        throw new Error(result.message || result.error || 'Failed to submit enquiry');
      }

      setFormSubmitted(true);
      
      // Reset form fields
      setFormData({
        name: '',
        phone: '',
        email: '',
        location: '',
        lookingFor: 'Buy',
        propertyType: 'Apartment',
        bedrooms: '2 BHK',
        budget: '₹50–75 Lakhs',
        callbackTime: 'Evening',
      });
      
      fetchData(false);
    } catch (err) {
      console.error('Submission error:', err);
      setSubmitError(err.message || 'An error occurred during submission.');
    } finally {
      setSubmitting(false);
    }
  };

  // --- Update status in SQLite from detail view ---
  const handleUpdateStatus = async (leadId, field, value) => {
    try {
      const res = await fetch(`/api/leads/${leadId}/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ [field]: value }),
      });

      if (!res.ok) {
        throw new Error('Failed to update status on server');
      }

      const updatedLead = await res.json();
      
      setLeads((prevLeads) =>
        prevLeads.map((lead) => (lead.id === leadId ? updatedLead : lead))
      );
    } catch (err) {
      console.error('Update status error:', err);
      alert('Failed to update status: ' + err.message);
    }
  };

  // --- Statistics calculation from REAL SQLite data ---
  const totalLeads = leads.length;
  const callsCompleted = leads.filter((l) => String(l.call_status).toUpperCase() === 'COMPLETED').length;
  const meetingsBooked = leads.filter((l) => l.meeting_status === 'Booked').length;
  const interestedLeads = leads.filter((l) => l.lead_status === 'Interested').length;

  return (
    <div className="fade-in">
      {/* Premium Navbar */}
      <nav className="navbar">
        <div className="navbar-content">
          <div className="logo" onClick={() => navigate('/')} style={{ cursor: 'pointer' }}>
            <span className="logo-icon">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
              </svg>
            </span>
            CASAGRAND
          </div>
          <ul className="nav-links">
            <li>
              <span
                className={`nav-link ${currentPath === '/' ? 'active' : ''}`}
                onClick={() => navigate('/')}
              >
                Enquiry Form
              </span>
            </li>
            <li>
              <span
                className={`nav-link ${currentPath === '/admin' ? 'active' : ''}`}
                onClick={() => navigate('/admin')}
              >
                Admin Dashboard
              </span>
            </li>
          </ul>
        </div>
      </nav>

      {/* Main Container */}
      <main className="app-container">
        {currentPath === '/admin' ? (
          /* ==========================================
             PAGE 2: ADMIN DASHBOARD
             ========================================== */
          <div className="fade-in">
            <div className="dashboard-header">
              <h1 style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                CASAGRAND — Lead Dashboard
                {loading && (
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', fontWeight: 400 }}>
                    (Syncing...)
                  </span>
                )}
              </h1>
            </div>

            {error && (
              <div style={{ padding: '1rem', backgroundColor: 'var(--color-failed-bg)', border: '1px solid var(--color-failed)', borderRadius: 'var(--border-radius-sm)', marginBottom: '1.5rem', color: 'var(--color-failed)', fontSize: '0.9rem' }}>
                {error}
              </div>
            )}

            {/* Quick Stats Grid */}
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-icon-wrapper">
                  <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                  </svg>
                </div>
                <div className="stat-info">
                  <span className="stat-label">Total Leads</span>
                  <span className="stat-value">{totalLeads}</span>
                </div>
              </div>

              <div className="stat-card">
                <div className="stat-icon-wrapper">
                  <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 9.92v7Z" />
                  </svg>
                </div>
                <div className="stat-info">
                  <span className="stat-label">Calls Completed</span>
                  <span className="stat-value">{callsCompleted}</span>
                </div>
              </div>

              <div className="stat-card">
                <div className="stat-icon-wrapper">
                  <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                    <line x1="16" y1="2" x2="16" y2="6" />
                    <line x1="8" y1="2" x2="8" y2="6" />
                    <line x1="3" y1="10" x2="21" y2="10" />
                  </svg>
                </div>
                <div className="stat-info">
                  <span className="stat-label">Meetings Booked</span>
                  <span className="stat-value">{meetingsBooked}</span>
                </div>
              </div>

              <div className="stat-card">
                <div className="stat-icon-wrapper">
                  <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
                  </svg>
                </div>
                <div className="stat-info">
                  <span className="stat-label">Interested Leads</span>
                  <span className="stat-value">{interestedLeads}</span>
                </div>
              </div>
            </div>

            {/* Main Content Area */}
            <div className={`dashboard-layout ${selectedLead ? 'split-view' : ''}`}>
              {/* Leads Table */}
              <div className="table-card">
                <div className="table-header">
                  <span className="table-title">Customer Enquiries</span>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Showing {leads.length} records • Click a row to view details
                  </span>
                </div>
                <div className="table-wrapper">
                  {leads.length === 0 && !loading ? (
                    <div className="empty-state">
                      <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="8" x2="12" y2="12" />
                        <line x1="12" y1="16" x2="12.01" y2="16" />
                      </svg>
                      <p>No leads found. Go to the Enquiry Form to add one.</p>
                    </div>
                  ) : (
                    <table className="leads-table">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Phone</th>
                          <th>Email</th>
                          <th>Location</th>
                          <th>Requirement</th>
                          <th>Call Status</th>
                          <th>Meeting</th>
                          <th>Lead Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {leads.map((lead) => (
                          <tr
                            key={lead.id}
                            className={selectedLeadId === lead.id ? 'selected' : ''}
                            onClick={() => setSelectedLeadId(lead.id)}
                          >
                            <td className="lead-name-cell">{lead.name}</td>
                            <td>{lead.phone}</td>
                            <td>{lead.email}</td>
                            <td>{lead.location}</td>
                            <td className="lead-req-cell">{lead.requirement}</td>
                            <td>
                              <span className={`badge badge-${lead.call_status.toLowerCase()}`}>
                                {lead.call_status}
                              </span>
                            </td>
                            <td>
                              <span className={`badge badge-${lead.meeting_status.toLowerCase().replace(' ', '')}`}>
                                {lead.meeting_status}
                              </span>
                            </td>
                            <td>
                              <span className={`badge badge-${lead.lead_status.toLowerCase().replace(' ', '')}`}>
                                {lead.lead_status}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>

              {/* Side Detail Panel (Drawer) */}
              {selectedLead && (
                <div className="details-card">
                  <div className="details-header">
                    <span className="details-title">
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      Lead Details
                    </span>
                    <button className="btn-close" onClick={() => setSelectedLeadId(null)}>
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                  <div className="details-card-scroll" style={{ maxHeight: '80vh', overflowY: 'auto' }}>
                    <div className="details-body">
                      
                      {/* Section 1: Call Details */}
                      <div className="details-section-title">Call Details</div>
                      <div className="details-info-grid" style={{ marginBottom: '1.5rem' }}>
                        <div className="info-item" style={{ gridColumn: 'span 2' }}>
                          <span className="info-label">Agent</span>
                          <span className="info-value" style={{ color: '#a5b4fc', fontWeight: '700' }}>
                            {selectedCallDetails?.agent_id ? (selectedCallDetails.agent_id == 596 ? 'Robert' : selectedCallDetails.agent_id) : 'Robert'}
                          </span>
                        </div>
                        <div className="info-item" style={{ gridColumn: 'span 2' }}>
                          <span className="info-label">Call ID</span>
                          <span className="info-value" style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>
                            {selectedLead.snapserve_call_id || 'N/A'}
                          </span>
                        </div>
                        <div className="info-item">
                          <span className="info-label">Status</span>
                          <span className="info-value" style={{ fontWeight: '700' }}>
                            {selectedLead.call_status || 'N/A'}
                          </span>
                        </div>
                        <div className="info-item">
                          <span className="info-label">Duration</span>
                          <span className="info-value">
                            {selectedCallDetails?.duration ? (selectedCallDetails.duration.includes('s') ? selectedCallDetails.duration.replace('s', ' seconds') : selectedCallDetails.duration) : 'N/A'}
                          </span>
                        </div>
                        <div className="info-item">
                          <span className="info-label">Started</span>
                          <span className="info-value" style={{ fontSize: '0.8rem' }}>{selectedCallDetails?.started_at || 'N/A'}</span>
                        </div>
                        <div className="info-item">
                          <span className="info-label">Ended</span>
                          <span className="info-value" style={{ fontSize: '0.8rem' }}>{selectedCallDetails?.ended_at || 'N/A'}</span>
                        </div>
                      </div>

                      {/* Section 2: Call Summary */}
                      <div className="details-section-title">Call Summary</div>
                      <div className="ai-summary-box" style={{ marginBottom: '1.5rem' }}>
                        <div className="ai-summary-text">
                          {loadingCallDetails ? 'Loading...' : (selectedCallDetails?.summary || 'Summary not available from SnapServe')}
                        </div>
                      </div>

                      {/* Section 3: Transcript */}
                      <div className="details-section-title">Transcript</div>
                      <div style={{ backgroundColor: 'rgba(0,0,0,0.2)', padding: '1rem', borderRadius: 'var(--border-radius-sm)', border: '1px solid var(--border-color)', marginBottom: '1.5rem', maxHeight: '180px', overflowY: 'auto' }}>
                        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'var(--font-main)', fontSize: '0.85rem', color: '#e2e8f0', lineHeight: 1.5 }}>
                          {loadingCallDetails ? 'Loading...' : (selectedCallDetails?.transcript || 'Transcript not available from SnapServe')}
                        </pre>
                      </div>

                      {/* Section 4: Call Recording */}
                      <div className="details-section-title">Call Recording</div>
                      <div style={{ marginBottom: '1.5rem' }}>
                        {selectedCallDetails && selectedCallDetails.recording_url ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                            <audio 
                              controls 
                              src={selectedCallDetails.recording_url} 
                              style={{ width: '100%', outline: 'none' }}
                            >
                              Your browser does not support the audio element.
                            </audio>
                            <a
                              href={selectedCallDetails.recording_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="btn-secondary"
                              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1rem', width: 'fit-content' }}
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                              </svg>
                              Open Recording Link
                            </a>
                          </div>
                        ) : (
                          <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Recording not available from SnapServe</span>
                        )}
                      </div>

                      {/* Section 5: Lead Information */}
                      <div className="details-section-title">Lead Information</div>
                      <div className="details-info-grid" style={{ marginBottom: '1.5rem' }}>
                        <div className="info-item">
                          <span className="info-label">Lead Name</span>
                          <span className="info-value">{selectedLead.name}</span>
                        </div>
                        <div className="info-item">
                          <span className="info-label">Lead Phone</span>
                          <span className="info-value">{selectedLead.phone}</span>
                        </div>
                        <div className="info-item" style={{ gridColumn: 'span 2' }}>
                          <span className="info-label">Lead Email</span>
                          <span className="info-value">{selectedLead.email}</span>
                        </div>
                        <div className="info-item">
                          <span className="info-label">Location</span>
                          <span className="info-value">{selectedLead.location}</span>
                        </div>
                        <div className="info-item" style={{ gridColumn: 'span 2' }}>
                          <span className="info-label">Property Requirement</span>
                          <span className="info-value">{selectedLead.requirement}</span>
                        </div>
                      </div>

                      {/* Section 6: Workflow Simulator */}
                      <div className="details-section-title">Workflow Simulator</div>
                      <div className="status-controls">
                        <div className="status-control-group">
                          <span className="info-label">Call Status</span>
                          <select
                            className="status-select-sm"
                            value={selectedLead.call_status}
                            onChange={(e) => handleUpdateStatus(selectedLead.id, 'callStatus', e.target.value)}
                          >
                            <option value="PENDING">PENDING</option>
                            <option value="TRIGGERED">TRIGGERED</option>
                            <option value="CALLING">CALLING</option>
                            <option value="COMPLETED">COMPLETED</option>
                            <option value="FAILED">FAILED</option>
                          </select>
                        </div>

                        <div className="status-control-group">
                          <span className="info-label">Meeting Status</span>
                          <select
                            className="status-select-sm"
                            value={selectedLead.meeting_status}
                            onChange={(e) => handleUpdateStatus(selectedLead.id, 'meetingStatus', e.target.value)}
                          >
                            <option value="Not Booked">Not Booked</option>
                            <option value="Booked">Booked</option>
                          </select>
                        </div>

                        <div className="status-control-group">
                          <span className="info-label">Lead Qualification</span>
                          <select
                            className="status-select-sm"
                            value={selectedLead.lead_status}
                            onChange={(e) => handleUpdateStatus(selectedLead.id, 'leadStatus', e.target.value)}
                          >
                            <option value="New">New</option>
                            <option value="Interested">Interested</option>
                            <option value="Not Interested">Not Interested</option>
                            <option value="Follow-up">Follow-up</option>
                          </select>
                        </div>
                      </div>

                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          /* ==========================================
             PAGE 1: CUSTOMER LEAD FORM
             ========================================== */
          <div className="fade-in">
            {/* Hero Section */}
            <div className="hero-section">
              <span className="hero-tagline">AI Real Estate Agent</span>
              <h1>CASAGRAND</h1>
              <div className="hero-subtitle">Find Your Perfect Property With Our CASAGRAND AI Assistant</div>
              <p className="hero-description">
                Tell us what you're looking for. Our AI property assistant will contact you,
                understand your requirements, and help you schedule a property consultation.
              </p>
            </div>

            {formSubmitted ? (
              /* Thank You State */
              <div className="thank-you-card fade-in">
                <div className="success-icon">
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <h2 className="thank-you-title">Thank You!</h2>
                <p className="thank-you-text">
                  Your property enquiry has been received. Our AI assistant will contact you shortly.
                </p>
                <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
                  <button className="btn-secondary" onClick={() => setFormSubmitted(false)}>
                    Submit Another Enquiry
                  </button>
                  <button className="btn-primary" style={{ marginTop: 0, width: 'auto' }} onClick={() => navigate('/admin')}>
                    View Admin Dashboard
                  </button>
                </div>
              </div>
            ) : (
              /* Enquiry Form */
              <div className="form-card">
                <h2 className="form-title">Request a Property Consultation</h2>
                {submitError && (
                  <div style={{ padding: '0.75rem', backgroundColor: 'var(--color-failed-bg)', border: '1px solid var(--color-failed)', borderRadius: 'var(--border-radius-sm)', marginBottom: '1.5rem', color: 'var(--color-failed)', fontSize: '0.9rem' }}>
                    {submitError}
                  </div>
                )}
                <form onSubmit={handleFormSubmit}>
                  <div className="form-grid">
                    
                    {/* Full Name */}
                    <div className="form-group-full">
                      <label className="form-label" htmlFor="fullName">
                        Full Name<span className="required-asterisk">*</span>
                      </label>
                      <input
                        type="text"
                        id="fullName"
                        className="form-input"
                        placeholder="Enter your full name"
                        value={formData.name}
                        onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                        required
                        disabled={submitting}
                      />
                    </div>

                    {/* Phone Number */}
                    <div>
                      <label className="form-label" htmlFor="phone">
                        Phone Number<span className="required-asterisk">*</span>
                      </label>
                      <input
                        type="tel"
                        id="phone"
                        className="form-input"
                        placeholder="Enter 10-digit mobile number"
                        value={formData.phone}
                        onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                        pattern="[0-9]{10}"
                        title="Please enter a valid 10-digit phone number"
                        required
                        disabled={submitting}
                      />
                    </div>

                    {/* Email */}
                    <div>
                      <label className="form-label" htmlFor="email">
                        Email Address<span className="required-asterisk">*</span>
                      </label>
                      <input
                        type="email"
                        id="email"
                        className="form-input"
                        placeholder="name@example.com"
                        value={formData.email}
                        onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                        required
                        disabled={submitting}
                      />
                    </div>

                    {/* Preferred Location */}
                    <div>
                      <label className="form-label" htmlFor="location">
                        Preferred Location<span className="required-asterisk">*</span>
                      </label>
                      <input
                        type="text"
                        id="location"
                        className="form-input"
                        placeholder="e.g., OMR, Velachery, Adyar"
                        value={formData.location}
                        onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                        required
                        disabled={submitting}
                      />
                    </div>

                    {/* Looking For */}
                    <div>
                      <label className="form-label">Looking To</label>
                      <div className="tab-options">
                        <div
                          className={`tab-option ${formData.lookingFor === 'Buy' ? 'active' : ''}`}
                          onClick={() => !submitting && setFormData({ ...formData, lookingFor: 'Buy' })}
                        >
                          Buy
                        </div>
                        <div
                          className={`tab-option ${formData.lookingFor === 'Rent' ? 'active' : ''}`}
                          onClick={() => !submitting && setFormData({ ...formData, lookingFor: 'Rent' })}
                        >
                          Rent
                        </div>
                      </div>
                    </div>

                    {/* Property Type */}
                    <div>
                      <label className="form-label" htmlFor="propertyType">
                        Property Type
                      </label>
                      <select
                        id="propertyType"
                        className="form-select"
                        value={formData.propertyType}
                        onChange={(e) => setFormData({ ...formData, propertyType: e.target.value })}
                        disabled={submitting}
                      >
                        <option value="Apartment">Apartment</option>
                        <option value="Villa">Villa</option>
                        <option value="Independent House">Independent House</option>
                      </select>
                    </div>

                    {/* Bedrooms */}
                    <div>
                      <label className="form-label" htmlFor="bedrooms">
                        Bedrooms
                      </label>
                      <select
                        id="bedrooms"
                        className="form-select"
                        value={formData.bedrooms}
                        onChange={(e) => setFormData({ ...formData, bedrooms: e.target.value })}
                        disabled={submitting}
                      >
                        <option value="1 BHK">1 BHK</option>
                        <option value="2 BHK">2 BHK</option>
                        <option value="3 BHK">3 BHK</option>
                        <option value="4+ BHK">4+ BHK</option>
                      </select>
                    </div>

                    {/* Budget */}
                    <div>
                      <label className="form-label" htmlFor="budget">
                        Budget
                      </label>
                      <select
                        id="budget"
                        className="form-select"
                        value={formData.budget}
                        onChange={(e) => setFormData({ ...formData, budget: e.target.value })}
                        disabled={submitting}
                      >
                        <option value="Below ₹50 Lakhs">Below ₹50 Lakhs</option>
                        <option value="₹50–75 Lakhs">₹50–75 Lakhs</option>
                        <option value="₹75 Lakhs–₹1 Crore">₹75 Lakhs–₹1 Crore</option>
                        <option value="Above ₹1 Crore">Above ₹1 Crore</option>
                      </select>
                    </div>

                    {/* Preferred Callback Time */}
                    <div className="form-group-full">
                      <label className="form-label" htmlFor="callbackTime">
                        Preferred Callback Time
                      </label>
                      <select
                        id="callbackTime"
                        className="form-select"
                        value={formData.callbackTime}
                        onChange={(e) => setFormData({ ...formData, callbackTime: e.target.value })}
                        disabled={submitting}
                      >
                        <option value="Morning">Morning</option>
                        <option value="Afternoon">Afternoon</option>
                        <option value="Evening">Evening</option>
                      </select>
                    </div>

                  </div>

                  <button type="submit" className="btn-primary" disabled={submitting}>
                    {submitting ? 'Submitting...' : 'Request AI Callback'}
                  </button>
                </form>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
