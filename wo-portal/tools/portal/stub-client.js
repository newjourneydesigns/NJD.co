// ---------------------------------------------------------------------------
// A fake Supabase client, injected into the page by tools/portal/smoke.mjs
// before any portal module runs.
//
// The smoke test's job is to prove that every screen builds its DOM without
// throwing — that the queries name real columns, that the render functions
// survive the shapes they are handed, that nothing imports a module that is
// gone. None of that needs a network, and depending on one would make the test
// slow, flaky, and impossible to run without an account.
//
// So this stands in for the vendored SDK: the same builder chain, answering
// from the fixtures below. It is deliberately permissive about *filters* — it
// applies the ones that matter for shape (eq on a foreign key, limit, order)
// and ignores the rest — because the point is the rendering, not the query
// planner. tools/portal/live-check.mjs is where the real queries are proven
// against the real database.
//
// The fixtures are chosen to hit the awkward paths rather than the happy one:
// an invoice that is overdue, one part-paid, one void, a client with no
// address, an expense with no receipt, a vendor over the 1099 threshold with
// no W-9, a category that needs substantiation.
// ---------------------------------------------------------------------------

(() => {
  const iso = (d) => d.toISOString().slice(0, 10);
  const today = new Date();
  const daysAgo = (n) => iso(new Date(today.getTime() - n * 86400000));
  const daysAhead = (n) => iso(new Date(today.getTime() + n * 86400000));
  const year = today.getFullYear();

  const CLIENTS = [
    {
      id: 'c1', name: 'Switch Commerce', legal_name: 'Switch Commerce LLC',
      contact_name: 'Dana Reid', contact_email: 'dana@example.com', contact_phone: '(940) 555-0123',
      website: 'https://example.com', address_line1: '100 Main Street', address_line2: 'Suite 4',
      city: 'Denton', region: 'Texas', postal_code: '76201', country: null,
      status: 'active', notes: 'ACH payer.', hourly_rate_cents: 15000, net_days: 30,
      created_at: `${year}-01-04T10:00:00Z`, updated_at: `${year}-01-04T10:00:00Z`,
    },
    {
      // No address, no contact, no negotiated rate: every optional field empty.
      id: 'c2', name: 'Cactus Paint Co', legal_name: null,
      contact_name: null, contact_email: null, contact_phone: null, website: null,
      address_line1: null, address_line2: null, city: null, region: null,
      postal_code: null, country: null, status: 'lead', notes: null,
      hourly_rate_cents: null, net_days: null,
      created_at: `${year}-02-01T10:00:00Z`, updated_at: `${year}-02-01T10:00:00Z`,
    },
    {
      id: 'c3', name: 'Heddi Strategies', legal_name: null, contact_name: 'Sam Ali',
      contact_email: 'sam@example.com', contact_phone: null, website: null,
      address_line1: '9 Oak Road', address_line2: null, city: 'Frisco', region: 'Texas',
      postal_code: '75034', country: null, status: 'past', notes: null,
      hourly_rate_cents: null, net_days: null,
      created_at: `${year - 1}-06-01T10:00:00Z`, updated_at: `${year - 1}-06-01T10:00:00Z`,
    },
  ];
  const clientOf = (id) => {
    const c = CLIENTS.find((x) => x.id === id);
    return c ? { ...c } : null;
  };

  const INVOICES = [
    {
      id: 'i1', client_id: 'c1', number: '20260901-1', status: 'sent',
      issued_on: daysAgo(40), due_on: daysAgo(10), net_days: 30,
      project_name: 'Website build', purchase_order: 'PO-88',
      summary: 'Phase one.', notes: null,
      subtotal_cents: 450000, tax_rate_bp: 0, tax_cents: 0,
      paid_cents: 200000, total_cents: 450000, currency: 'usd', paid_at: null,
      issued_at: `${year}-09-01T12:00:00Z`, snapshot_hash: 'aaa',
      created_by: 'u1', created_at: `${year}-09-01T12:00:00Z`, updated_at: `${year}-09-01T12:00:00Z`,
      client: clientOf('c1'),
    },
    {
      id: 'i2', client_id: 'c2', number: '20260902-1', status: 'draft',
      issued_on: iso(today), due_on: daysAhead(15), net_days: 15,
      project_name: '', purchase_order: null, summary: null, notes: null,
      subtotal_cents: 0, tax_rate_bp: 0, tax_cents: 0,
      paid_cents: 0, total_cents: 0, currency: 'usd', paid_at: null,
      issued_at: null, snapshot_hash: null,
      created_by: 'u1', created_at: `${year}-09-02T12:00:00Z`, updated_at: `${year}-09-02T12:00:00Z`,
      client: clientOf('c2'),
    },
    {
      id: 'i3', client_id: 'c1', number: '20260815-1', status: 'paid',
      issued_on: daysAgo(60), due_on: daysAgo(30), net_days: 30,
      project_name: 'Logo', purchase_order: null, summary: null, notes: null,
      subtotal_cents: 120000, tax_rate_bp: 825, tax_cents: 9900,
      paid_cents: 129900, total_cents: 129900, currency: 'usd',
      paid_at: `${year}-08-20T12:00:00Z`,
      issued_at: `${year}-08-15T12:00:00Z`, snapshot_hash: 'bbb',
      created_by: 'u1', created_at: `${year}-08-15T12:00:00Z`, updated_at: `${year}-08-20T12:00:00Z`,
      client: clientOf('c1'),
    },
    {
      id: 'i4', client_id: 'c3', number: '20260701-1', status: 'void',
      issued_on: daysAgo(90), due_on: daysAgo(75), net_days: 15,
      project_name: 'Cancelled', purchase_order: null, summary: null, notes: null,
      subtotal_cents: 50000, tax_rate_bp: 0, tax_cents: 0,
      paid_cents: 0, total_cents: 50000, currency: 'usd', paid_at: null,
      issued_at: `${year}-07-01T12:00:00Z`, snapshot_hash: 'ccc',
      created_by: 'u1', created_at: `${year}-07-01T12:00:00Z`, updated_at: `${year}-07-02T12:00:00Z`,
      client: clientOf('c3'),
    },
  ];

  // The frozen document i1 and i3 print from.
  const snapshotFor = (inv) => ({
    kind: 'invoice', version: 1, number: inv.number, label: `Invoice ${inv.number}`,
    issued_on: inv.issued_on, due_on: inv.due_on, net_days: inv.net_days,
    from: {
      name: 'Walter Ochenski LLC', entityLine: null,
      address: ['2001 Creekdale Drive', 'Denton, Texas 76210'],
      phone: '(972) 467-5988', email: 'tripochinski@gmail.com', website: null,
      payeeName: 'Walter Ochenski',
    },
    billed_to: {
      name: inv.client?.legal_name || inv.client?.name || 'Client',
      workingName: inv.client?.name || null,
      address: ['100 Main Street', 'Denton, Texas 76201'],
      contactName: inv.client?.contact_name || null,
      contactEmail: inv.client?.contact_email || null,
      contactPhone: inv.client?.contact_phone || null,
    },
    project_name: inv.project_name, purchase_order: inv.purchase_order,
    summary: inv.summary,
    lines: [{
      name: 'Marketing consulting', description: 'Discovery and strategy',
      quantity: 30, unit_cents: 15000, amount_cents: inv.subtotal_cents, taxable: inv.tax_cents > 0,
    }],
    subtotal_cents: inv.subtotal_cents,
    tax: { label: 'Sales tax', rate_bp: inv.tax_rate_bp, cents: inv.tax_cents, registration: null },
    total_cents: inv.total_cents,
    payment_details: 'Checks payable to Walter Ochenski, or direct ACH.',
    late_note: null, notes: null,
  });
  for (const inv of INVOICES) inv.snapshot = inv.issued_at ? snapshotFor(inv) : null;

  const INVOICE_ITEMS = [
    { id: 'li1', invoice_id: 'i1', name: 'Marketing consulting', description: 'Discovery and strategy', quantity: 30, unit_cents: 15000, amount_cents: 450000, taxable: false, position: 0 },
    { id: 'li3', invoice_id: 'i3', name: 'Logo design', description: null, quantity: 1, unit_cents: 120000, amount_cents: 120000, taxable: true, position: 0 },
  ];

  const PAYMENTS = [
    { id: 'p1', invoice_id: 'i1', client_id: 'c1', received_on: daysAgo(20), amount_cents: 200000, method: 'ach', reference: 'ACH-771', notes: null, created_at: `${year}-09-10T12:00:00Z`, invoice: { number: '20260901-1', client_id: 'c1' }, client: { id: 'c1', name: 'Switch Commerce' } },
    { id: 'p2', invoice_id: 'i3', client_id: 'c1', received_on: daysAgo(50), amount_cents: 129900, method: 'check', reference: '1042', notes: null, created_at: `${year}-08-20T12:00:00Z`, invoice: { number: '20260815-1', client_id: 'c1' }, client: { id: 'c1', name: 'Switch Commerce' } },
  ];

  const CATEGORIES = [
    { id: 'g1', code: 'software', name: 'Software & subscriptions', schedule_c_line: '27a', description: 'The monthly stack.', needs_substantiation: false, needs_attendees: false, half_deductible: false, position: 100, archived_at: null },
    { id: 'g2', code: 'meals', name: 'Business meals', schedule_c_line: '24b', description: 'Half deductible.', needs_substantiation: true, needs_attendees: true, half_deductible: true, position: 90, archived_at: null },
    { id: 'g3', code: 'contract_labor', name: 'Contract labor', schedule_c_line: '11', description: 'Other people’s work.', needs_substantiation: false, needs_attendees: false, half_deductible: false, position: 30, archived_at: null },
    { id: 'g4', code: 'travel', name: 'Travel', schedule_c_line: '24a', description: 'Trips.', needs_substantiation: true, needs_attendees: false, half_deductible: false, position: 80, archived_at: null },
    { id: 'g5', code: 'retired', name: 'Retired category', schedule_c_line: '27a', description: '', needs_substantiation: false, needs_attendees: false, half_deductible: false, position: 500, archived_at: `${year - 1}-01-01T00:00:00Z` },
  ];
  const categoryOf = (id) => {
    const c = CATEGORIES.find((x) => x.id === id);
    return c ? { ...c } : null;
  };

  const VENDORS = [
    { id: 'v1', name: 'Adobe', email: null, phone: null, website: null, address: null, files_1099: false, tax_id_on_file: false, default_category_id: 'g1', notes: null, archived_at: null },
    // Over the 1099 threshold with no W-9: the row the dashboard should shout about.
    { id: 'v2', name: 'Jordan Pike', email: 'jordan@example.com', phone: null, website: null, address: null, files_1099: true, tax_id_on_file: false, default_category_id: 'g3', notes: null, archived_at: null },
    { id: 'v3', name: 'Old Supplier', email: null, phone: null, website: null, address: null, files_1099: false, tax_id_on_file: false, default_category_id: null, notes: null, archived_at: `${year - 1}-03-01T00:00:00Z` },
  ];
  const vendorOf = (id) => {
    const v = VENDORS.find((x) => x.id === id);
    return v ? { id: v.id, name: v.name, files_1099: v.files_1099 } : null;
  };

  const RECEIPTS = [
    { id: 'r1', expense_id: 'e1', storage_path: 'e1/a-receipt.jpg', thumb_path: 'e1/a-receipt-thumb.jpg', name: 'receipt.jpg', size_bytes: 90210, mime_type: 'image/jpeg', captured_on: daysAgo(12), position: 0, uploaded_by: 'u1', created_at: `${year}-08-25T12:00:00Z` },
  ];

  const EXPENSES = [
    { id: 'e1', spent_on: daysAgo(12), vendor_id: 'v1', vendor_name: null, category_id: 'g1', amount_cents: 5499, description: 'Creative Cloud', method: 'card', reference: null, client_id: null, billable: false, billed_invoice_id: null, place: null, business_purpose: null, attendees: null, created_by: 'u1', created_at: `${year}-08-25T12:00:00Z`, category: categoryOf('g1'), vendor: vendorOf('v1'), client: null, creator: { full_name: 'Walter Ochenski' }, receipts: [RECEIPTS[0]] },
    // No receipt, and a category that wants substantiation it does not have.
    { id: 'e2', spent_on: daysAgo(5), vendor_id: null, vendor_name: 'Local Diner', category_id: 'g2', amount_cents: 8600, description: 'Lunch with a prospect', method: 'card', reference: null, client_id: 'c1', billable: true, billed_invoice_id: null, place: null, business_purpose: null, attendees: null, created_by: 'u1', created_at: `${year}-09-01T12:00:00Z`, category: categoryOf('g2'), vendor: null, client: { id: 'c1', name: 'Switch Commerce' }, creator: { full_name: 'Walter Ochenski' }, receipts: [] },
    { id: 'e3', spent_on: daysAgo(35), vendor_id: 'v2', vendor_name: null, category_id: 'g3', amount_cents: 320000, description: 'Contract development', method: 'ach', reference: null, client_id: 'c1', billable: true, billed_invoice_id: 'i1', place: null, business_purpose: null, attendees: null, created_by: 'u1', created_at: `${year}-08-01T12:00:00Z`, category: categoryOf('g3'), vendor: vendorOf('v2'), client: { id: 'c1', name: 'Switch Commerce' }, creator: { full_name: 'Walter Ochenski' }, receipts: [] },
    // A refund: a negative amount, which several sums must not choke on.
    { id: 'e4', spent_on: daysAgo(3), vendor_id: 'v1', vendor_name: null, category_id: 'g1', amount_cents: -1200, description: 'Refunded seat', method: 'card', reference: null, client_id: null, billable: false, billed_invoice_id: null, place: null, business_purpose: null, attendees: null, created_by: 'u1', created_at: `${year}-09-02T12:00:00Z`, category: categoryOf('g1'), vendor: vendorOf('v1'), client: null, creator: { full_name: 'Walter Ochenski' }, receipts: [] },
  ];

  const TABLES = {
    clients: CLIENTS,
    invoices: INVOICES,
    invoice_items: INVOICE_ITEMS,
    payments: PAYMENTS,
    expenses: EXPENSES,
    expense_categories: CATEGORIES,
    expense_receipts: RECEIPTS,
    vendors: VENDORS,
    recurring_expenses: [
      { id: 'rc1', name: 'Creative Cloud', vendor_id: 'v1', vendor_name: null, category_id: 'g1', amount_cents: 5499, method: 'card', day_of_month: 4, client_id: null, billable: false, active: true, last_recorded_on: daysAgo(12), category: categoryOf('g1'), vendor: vendorOf('v1') },
      { id: 'rc2', name: 'Domain renewals', vendor_id: null, vendor_name: 'Namecheap', category_id: 'g1', amount_cents: 2400, method: 'card', day_of_month: 28, client_id: null, billable: false, active: false, last_recorded_on: null, category: categoryOf('g1'), vendor: null },
    ],
    documents: [
      { id: 'd1', client_id: 'c1', name: 'Signed proposal.pdf', storage_path: 'c1/x-signed-proposal.pdf', label: 'Proposal', size_bytes: 240512, mime_type: 'application/pdf', uploaded_by: 'u1', created_at: `${year}-08-02T12:00:00Z`, uploaded_by_profile: { full_name: 'Walter Ochenski', email: 'walter@wo-portal.invalid' } },
      { id: 'd2', client_id: 'c1', name: 'W-9.pdf', storage_path: 'c1/y-w9.pdf', label: null, size_bytes: 88000, mime_type: 'application/pdf', uploaded_by: null, created_at: `${year}-08-03T12:00:00Z`, uploaded_by_profile: null },
    ],
    client_contacts: [
      { id: 'k1', client_id: 'c1', name: 'Dana Reid', title: 'Operations', email: 'dana@example.com', phone: '(940) 555-0123', position: 0 },
      { id: 'k2', client_id: 'c1', name: 'Chris Vale', title: null, email: null, phone: '(940) 555-0144', position: 1 },
    ],
    client_notes: [
      { id: 'n1', client_id: 'c1', body: 'Kickoff call. They want ACH.', author_id: 'u1', created_at: `${year}-08-01T12:00:00Z`, updated_at: `${year}-08-01T12:00:00Z`, author: { full_name: 'Walter Ochenski' } },
      { id: 'n2', client_id: 'c1', body: 'Edited later.', author_id: 'u2', created_at: `${year}-08-05T12:00:00Z`, updated_at: `${year}-08-06T12:00:00Z`, author: { full_name: 'Dana the bookkeeper' } },
    ],
    profiles: [
      { id: 'u1', email: 'walter@wo-portal.invalid', full_name: 'Walter Ochenski', role: 'owner', phone: '(972) 467-5988', created_at: `${year}-01-01T00:00:00Z` },
      { id: 'u2', email: 'books@wo-portal.invalid', full_name: 'Dana the bookkeeper', role: 'staff', phone: null, created_at: `${year}-02-01T00:00:00Z` },
      { id: 'u3', email: 'stray@wo-portal.invalid', full_name: '', role: 'none', phone: null, created_at: `${year}-03-01T00:00:00Z` },
    ],
    studio_settings: [{
      id: true, business_name: 'Walter Ochenski LLC', entity_line: '',
      address_line1: '2001 Creekdale Drive', address_line2: '', city: 'Denton',
      region: 'Texas', postal_code: '76210', phone: '(972) 467-5988',
      email: 'tripochinski@gmail.com', website: '', payee_name: 'Walter Ochenski',
      hourly_rate_cents: 15000, nec_threshold_cents: 200000,
    }],
    invoice_settings: [{
      id: true,
      payment_details: 'Checks payable to Walter Ochenski, or direct ACH — bank details on request.',
      net_days: 15, late_note: null, tax_rate_bp: 0, tax_label: 'Sales tax', tax_registration: null,
    }],
  };

  const RPC = {
    create_invoice: () => 'i2',
    duplicate_invoice: () => 'i2',
    save_invoice: () => null,
    issue_invoice: () => new Date().toISOString(),
  };

  // --- the builder ---------------------------------------------------------
  //
  // Thenable, like PostgREST's: every method returns `this`, and awaiting it
  // resolves { data, error }. Filters that decide SHAPE are applied (eq, in,
  // is, limit, order, single/maybeSingle); the rest are recorded and ignored.
  class Query {
    constructor(rows) { this.rows = rows.map((r) => ({ ...r })); this.one = false; }

    select() { return this; }
    eq(col, val) { this.rows = this.rows.filter((r) => String(r[col]) === String(val)); return this; }
    neq(col, val) { this.rows = this.rows.filter((r) => String(r[col]) !== String(val)); return this; }
    in(col, vals) { this.rows = this.rows.filter((r) => vals.map(String).includes(String(r[col]))); return this; }
    is(col, val) {
      if (val === null) this.rows = this.rows.filter((r) => r[col] === null || r[col] === undefined);
      else this.rows = this.rows.filter((r) => r[col] === val);
      return this;
    }
    not(col, op, val) {
      if (op === 'is' && val === null) this.rows = this.rows.filter((r) => r[col] !== null && r[col] !== undefined);
      return this;
    }
    gte(col, val) { this.rows = this.rows.filter((r) => r[col] >= val); return this; }
    lte(col, val) { this.rows = this.rows.filter((r) => r[col] <= val); return this; }
    gt(col, val) { this.rows = this.rows.filter((r) => r[col] > val); return this; }
    lt(col, val) { this.rows = this.rows.filter((r) => r[col] < val); return this; }
    like() { return this; }
    ilike() { return this; }
    or() { return this; }
    filter() { return this; }
    contains() { return this; }
    order(col, opts = {}) {
      const dir = opts.ascending === false ? -1 : 1;
      this.rows.sort((a, b) => {
        const x = a[col]; const y = b[col];
        if (x === y) return 0;
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        return x < y ? -dir : dir;
      });
      return this;
    }
    limit(n) { this.rows = this.rows.slice(0, n); return this; }
    range(from, to) { this.rows = this.rows.slice(from, to + 1); return this; }
    single() { this.one = true; return this; }
    maybeSingle() { this.one = true; return this; }
    csv() { return this; }

    // Writes: accepted, echoed, never persisted. A screen that writes during a
    // read-only smoke run is a bug the test should not hide, but neither
    // should it explode — the assertion that matters is the console staying
    // clean, and these all resolve like the real thing.
    insert(payload) { this.written = payload; this.rows = [].concat(payload || []).map((r, i) => ({ id: `new${i}`, ...r })); return this; }
    upsert(payload) { return this.insert(payload); }
    update(patch) { this.rows = this.rows.map((r) => ({ ...r, ...patch })); return this; }
    delete() { this.rows = []; return this; }

    then(resolve, reject) {
      const data = this.one ? (this.rows[0] ?? null) : this.rows;
      return Promise.resolve({ data, error: null, count: this.rows.length }).then(resolve, reject);
    }
  }

  // Signed in unless the page was asked for signed out. Two states are worth
  // testing: every screen with somebody on it, and the bounce to the sign-in
  // page without. The flag rides the URL because the stub is loaded by the
  // page itself and has nothing else to read.
  const signedOut = new URLSearchParams(location.search).get('stub') === 'signedout';
  const session = signedOut ? null : {
    access_token: 'stub-token',
    user: { id: 'u1', email: 'walter@wo-portal.invalid' },
  };

  window.supabase = {
    createClient() {
      return {
        from(table) {
          if (!(table in TABLES)) {
            // Loud on purpose: a query against a table this portal does not
            // have is exactly the kind of bug this test exists to catch.
            console.error(`stub-client: unknown table "${table}"`);
            return new Query([]);
          }
          return new Query(TABLES[table]);
        },
        rpc(name, args) {
          if (!(name in RPC)) {
            console.error(`stub-client: unknown rpc "${name}"`);
            return Promise.resolve({ data: null, error: { message: `no rpc ${name}` } });
          }
          return Promise.resolve({ data: RPC[name](args), error: null });
        },
        auth: {
          getSession: () => Promise.resolve({ data: { session }, error: null }),
          getUser: () => Promise.resolve({ data: { user: session?.user ?? null }, error: null }),
          signInWithPassword: () => Promise.resolve({
            data: { session: session ?? { access_token: 'stub-token', user: { id: 'u1' } }, user: { id: 'u1' } },
            error: null,
          }),
          signOut: () => Promise.resolve({ error: null }),
          updateUser: () => Promise.resolve({ data: { user: session?.user ?? null }, error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        },
        storage: {
          from() {
            return {
              list: () => Promise.resolve({ data: [], error: null }),
              upload: () => Promise.resolve({ data: { path: 'stub/path' }, error: null }),
              remove: () => Promise.resolve({ data: [], error: null }),
              download: () => Promise.resolve({ data: new Blob(['stub']), error: null }),
              createSignedUrl: (path) => Promise.resolve({
                data: { signedUrl: `/assets/img/wo-mark.svg#${encodeURIComponent(path)}` }, error: null,
              }),
              getPublicUrl: () => ({ data: { publicUrl: '/assets/img/wo-mark.svg' } }),
            };
          },
        },
      };
    },
  };
})();
