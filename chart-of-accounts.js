/* ============================================================
   Tallo CPA - Philippines BIR Extension
   chart-of-accounts.js - COA builder tab: create/rename Manager
   GL accounts and groups, and map every account to one of the
   9 BIR income-tax categories used by 1701/1701Q/1702Q/1702RT.

   Also exposes a reusable account-picker (COA.accountOptionsHtml)
   used by the Payslip Items tab (expense/liability accounts) and
   the Tax Codes tab (VAT account overrides).

   Uses postMessage bridge (apiRequest from shared.js), and the
   read-only loadChartOfAccounts()/loadAccountGroups() caches from
   pnl-helpers.js. Mapping persisted via getCoaMapping/saveCoaMapping
   (shared.js), which share Manager's 'BIR Mapping Data' field.

   Operating Expenses accounts also get a BIR itemized-deduction
   sub-category (Schedule 4 / Schedule I), read/written via
   getDeductionOverrides/saveDeductionOverrides (deduction-helpers.js)
   — the same store the 1701/1701Q/1702Q/1702RT reports read, so a
   mapping saved here shows up there automatically.
   ============================================================ */

(function () {

  // ── BIR INCOME-TAX CATEGORIES ────────────────────────────────
  // 1:1 with account "type" — picking a category also tells us which
  // Manager endpoint (balance-sheet vs profit-and-loss) to use.
  var BIR_COA_CATEGORIES = [
    { id: 'acct-bir-asset',    label: 'Asset',              isPnL: false },
    { id: 'acct-bir-liab',     label: 'Liabilities',        isPnL: false },
    { id: 'acct-bir-equity',   label: 'Equity',             isPnL: false },
    { id: 'acct-bir-revenue',  label: 'Revenue',            isPnL: true  },
    { id: 'acct-bir-cogs',     label: 'Cost of Sales',      isPnL: true  },
    { id: 'acct-bir-cos',      label: 'Cost of Services',   isPnL: true  },
    { id: 'acct-bir-opex',     label: 'Operating Expenses', isPnL: true  },
    { id: 'acct-bir-oincome',  label: 'Other Income',       isPnL: true  },
    { id: 'acct-bir-oexpense', label: 'Other Expense',      isPnL: true  },
  ];

  function catById(id) {
    return BIR_COA_CATEGORIES.find(function (c) { return c.id === id; });
  }

  // ── NATIVE MANAGER MASTER GROUP GUIDS ────────────────────────
  // These top-level Asset/Liability/Revenue/Cost-of-Sales/Operating-Expenses
  // "father" groups are standard system records (same across all Manager
  // businesses) but are NOT returned by balance-sheet-group-batch /
  // profit-and-loss-statement-group-batch — only their editable *subgroups*
  // are. If an account or group is created with no `group` value at all,
  // Manager silently files it under Equity > Uncategorized regardless of
  // BIR Category picked here, which is wrong for Asset/Liability accounts.
  // Passing one of these GUIDs as the new group's own parent fixes that.
  // Cost of Services/Other Income/Other Expense have no confirmed master
  // GUID yet, so those still fall back to Manager's default (Equity).
  var NATIVE_MASTER_GROUP = {
    'acct-bir-asset':  '4c05c221-ca57-4c7c-be62-115669302ed4',
    'acct-bir-liab':   'ed5a19f6-12c5-45cc-b4b7-4e79f7ef50bc',
    'acct-bir-equity': '9275ff4c-4cff-41d0-b7b5-f31c783f03d8',
    'acct-bir-revenue':'95713fac-30d3-42e4-b536-dd7bc4f7a80e',
    'acct-bir-cogs':   '11eafe62-925c-4b6b-8321-1b5485a963cc',
    'acct-bir-opex':   'fd003045-876e-439e-b923-1904453f5c30',
  };

  // ── Local helpers (kept self-contained, same pattern as custom-fields.js) ──
  function esc(s) {
    return String(s != null ? s : '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function biz() {
    if (typeof currentBiz === 'function') return currentBiz();
    var sel = document.getElementById('business');
    if (sel) return sel.value;
    return (typeof App !== 'undefined' && App.currentBusiness) ? App.currentBusiness : '';
  }
  function noBusinessMsg() {
    return '<p class="muted">Select a business above to build its chart of accounts.</p>';
  }
  function spinner(msg) {
    return '<div class="status">' + esc(msg) + '</div>';
  }
  function flash(btn, ok) {
    if (!btn) return;
    var orig = btn.textContent;
    btn.textContent = ok ? '✓ Saved' : '✗ Failed';
    setTimeout(function () { btn.textContent = orig; }, 1400);
  }

  // ── PUBLIC: reusable account picker (used by Payslip Items & Tax Codes tabs) ──
  // coa: result of loadChartOfAccounts(biz) -- { guid: {key,name,group,isProfitAndLossAccount} }
  // opts.isPnL: if set, filter to only P&L or only Balance Sheet accounts
  // opts.selected: currently selected account guid
  function accountOptionsHtml(coa, opts) {
    opts = opts || {};
    var list = Object.values(coa || {});
    if (typeof opts.isPnL === 'boolean') {
      list = list.filter(function (a) { return a.isProfitAndLossAccount === opts.isPnL; });
    }
    list.sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
    var html = '<option value="">-- none --</option>';
    list.forEach(function (a) {
      var sel = a.key === opts.selected ? ' selected' : '';
      html += '<option value="' + esc(a.key) + '"' + sel + '>' + esc(a.name) + '</option>';
    });
    return html;
  }

  // ── MOUNT ─────────────────────────────────────────────────────
  function mountCoaSection(container) {
    var coa = {};       // accountGuid -> {key,name,group,isProfitAndLossAccount}
    var groups = { pnl: [], bs: [] };
    var coaMap = {};    // accountGuid -> 'acct-bir-<category>'
    var deductionOverrides = {}; // accountGuid -> DEDUCTION_SCHEDULE key (Operating Expenses only)

    // Same override store the 1701/1701Q/1702Q/1702RT itemized-deduction
    // schedules read via getDeductionOverrides() in deduction-helpers.js —
    // setting it here means the report screens pick it up automatically
    // instead of falling back to keyword auto-matching.
    function deductionCatFor(guid, name) {
      if (typeof autoMatchDeductionCategory !== 'function') return null;
      return deductionOverrides[guid] || autoMatchDeductionCategory(name);
    }

    function deductionSelectHtml(guid, name) {
      if (typeof DEDUCTION_SCHEDULE === 'undefined') return '';
      var current = deductionCatFor(guid, name);
      var opts = DEDUCTION_SCHEDULE.map(function (c) {
        var sel = c.key === current ? ' selected' : '';
        return '<option value="' + esc(c.key) + '"' + sel + '>' + esc(c.num) + ' – ' + esc(c.label) + '</option>';
      }).join('');
      return '<select data-role="deduction" style="width:100%;font-size:12px;">' + opts + '</select>';
    }

    async function refresh() {
      var business = biz();
      if (!business) { container.innerHTML = noBusinessMsg(); return; }
      container.innerHTML = spinner('Loading chart of accounts...');
      var loadError = '';
      try {
        coa = await loadChartOfAccounts(business, true);
      } catch (err) {
        console.error('[COA] loadChartOfAccounts failed:', err);
        coa = {};
        loadError += 'Accounts: ' + err.message + '. ';
      }
      try {
        groups = await loadAccountGroups(business, true);
      } catch (err) {
        console.error('[COA] loadAccountGroups failed:', err);
        groups = { pnl: [], bs: [] };
        loadError += 'Groups: ' + err.message + '. ';
      }
      try {
        coaMap = await getCoaMapping(business);
      } catch (err) {
        console.error('[COA] getCoaMapping failed:', err);
        coaMap = {};
        loadError += 'Mapping: ' + err.message + '. ';
      }
      deductionOverrides = (typeof getDeductionOverrides === 'function') ? getDeductionOverrides(business) : {};
      console.log('[COA] loaded', Object.keys(coa).length, 'accounts;', groups.pnl.length, 'P&L groups;', groups.bs.length, 'balance-sheet groups.');
      render(loadError);
    }

    function groupOptionsHtml(isPnL, selected) {
      var list = isPnL ? groups.pnl : groups.bs;
      var html = '<option value="">-- none --</option>';
      list.forEach(function (g) {
        var sel = g.key === selected ? ' selected' : '';
        html += '<option value="' + esc(g.key) + '"' + sel + '>' + esc(g.name) + '</option>';
      });
      html += '<option value="__new__">+ New group...</option>';
      return html;
    }

    function render(loadError) {
      var intro = '<p style="font-size:11px;color:#6b7280;margin-bottom:14px;">Click "+ Add Account" on a category below to add blank rows, fill them in, then "Save All" to post them to Manager in one go — or map accounts Manager already has to a BIR income-tax category so 1701/1701Q/1702Q/1702RT can classify them correctly.</p>' +
        '<p style="font-size:11px;color:#9ca3af;margin-bottom:14px;">Loaded ' + Object.keys(coa).length + ' account(s), ' + (groups.pnl.length + groups.bs.length) + ' group(s).</p>';
      var errorBanner = loadError ? '<div class="alert alert-error" style="margin-bottom:14px;">⚠ ' + esc(loadError) + '</div>' : '';
      container.innerHTML = errorBanner + intro + BIR_COA_CATEGORIES.map(renderCategoryTable).join('') + renderUnmappedTable();

      window._coaAddRow = onAddRow;
      container.querySelectorAll('[data-action="coa-save-row"]').forEach(function (btn) {
        btn.addEventListener('click', onSaveRow);
      });
      container.querySelectorAll('[data-action="coa-save-all"]').forEach(function (btn) {
        btn.addEventListener('click', onSaveAll);
      });
      container.querySelectorAll('[data-action="coa-remove-row"]').forEach(function (btn) {
        btn.addEventListener('click', function (e) { e.currentTarget.closest('tr').remove(); });
      });
      container.querySelectorAll('[data-role="newgroup"]').forEach(wireNewGroupSelect);
    }

    function wireNewGroupSelect(sel) {
      sel.addEventListener('change', function () {
        var row = sel.closest('tr');
        var nameInput = row.querySelector('[data-role="newgroupname"]');
        nameInput.style.display = sel.value === '__new__' ? 'block' : 'none';
      });
    }

    function accountsForCategory(catId) {
      return Object.keys(coaMap)
        .filter(function (guid) { return coaMap[guid] === catId; })
        .map(function (guid) { return coa[guid]; })
        .filter(Boolean)
        .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
    }

    function groupNameFor(guid, isPnL) {
      var list = isPnL ? groups.pnl : groups.bs;
      var g = list.find(function (x) { return x.key === guid; });
      return g ? g.name : '—';
    }

    function categoryRow(cat, acct) {
      var catOpts = BIR_COA_CATEGORIES.map(function (c) {
        var sel = c.id === cat.id ? ' selected' : '';
        return '<option value="' + esc(c.id) + '"' + sel + '>' + esc(c.label) + '</option>';
      }).join('');
      var deductionCell = cat.id === 'acct-bir-opex'
        ? '<td style="padding:6px 8px;">' + deductionSelectHtml(acct.key, acct.name) + '</td>'
        : '';
      return '<tr data-key="' + esc(acct.key) + '" style="border-bottom:.5px solid #f3f4f6;">' +
        '<td style="padding:6px 8px;"><input data-role="name" type="text" value="' + esc(acct.name) + '" style="font-size:12px;width:100%;border:1px solid #e5e7eb;border-radius:4px;padding:3px 6px;" /></td>' +
        '<td style="padding:6px 8px;font-size:12px;color:#6b7280;">' + esc(groupNameFor(acct.group, acct.isProfitAndLossAccount)) + '</td>' +
        '<td style="padding:6px 8px;"><select data-role="cat" style="width:100%;font-size:12px;">' + catOpts + '</select></td>' +
        deductionCell +
        '<td style="padding:6px 8px;"><button class="btn btn-primary btn-sm" data-action="coa-save-row" style="font-size:11px;">Save</button></td>' +
        '</tr>';
    }

    // Blank, not-yet-created row appended by "+ Add Account" — saved/created
    // by saveRow() the same pass as existing edits when "Save All" is clicked.
    function newAccountRowHtml(cat) {
      var deductionCell = cat.id === 'acct-bir-opex'
        ? '<td style="padding:6px 8px;">' + deductionSelectHtml('', '') + '</td>'
        : '';
      return '<tr data-new="true" data-cat="' + esc(cat.id) + '" style="border-bottom:.5px solid #f3f4f6;background:#f8fafc;">' +
        '<td style="padding:6px 8px;"><input data-role="name" type="text" placeholder="Account name" style="font-size:12px;width:100%;border:1px solid #e5e7eb;border-radius:4px;padding:3px 6px;" /></td>' +
        '<td style="padding:6px 8px;">' +
          '<select data-role="newgroup" style="width:100%;font-size:12px;">' + groupOptionsHtml(cat.isPnL, '') + '</select>' +
          '<input data-role="newgroupname" type="text" placeholder="New group name" style="font-size:12px;width:100%;border:1px solid #d1d5db;border-radius:4px;padding:3px 6px;margin-top:4px;display:none;" />' +
        '</td>' +
        '<td style="padding:6px 8px;font-size:12px;color:#6b7280;">' + esc(cat.label) + '</td>' +
        deductionCell +
        '<td style="padding:6px 8px;"><button data-action="coa-remove-row" style="font-size:11px;border:1px solid #d1d5db;border-radius:4px;background:#fff;cursor:pointer;padding:3px 8px;">✕</button></td>' +
        '</tr>';
    }

    function onAddRow(tableId, catId) {
      var table = document.getElementById(tableId);
      var cat = catById(catId);
      if (!table || !cat) return;
      table.querySelector('tbody').insertAdjacentHTML('beforeend', newAccountRowHtml(cat));
      var newRow = table.querySelector('tbody tr:last-child');
      wireNewGroupSelect(newRow.querySelector('[data-role="newgroup"]'));
      newRow.querySelector('[data-action="coa-remove-row"]').addEventListener('click', function (e) { e.currentTarget.closest('tr').remove(); });
      newRow.querySelector('[data-role="name"]').focus();
    }

    function renderCategoryTable(cat) {
      var accts = accountsForCategory(cat.id);
      var tableId = cat.id + '-tbl';
      var heading = '<h3 style="margin:16px 0 6px;font-size:13px;font-weight:500;display:flex;align-items:center;gap:10px;">' +
        '<span>' + esc(cat.label) + '</span>' +
        '<button onclick="window._coaAddRow(\'' + tableId + '\',\'' + cat.id + '\')" style="font-size:11px;padding:3px 12px;border:1px solid #d1d5db;border-radius:5px;background:#fff;cursor:pointer;">+ Add Account</button>' +
        '<button data-action="coa-save-all" data-table="' + tableId + '" style="font-size:11px;padding:3px 12px;border:1px solid #1a56db;border-radius:5px;background:#1a56db;color:#fff;cursor:pointer;">Save All</button>' +
        '</h3>';
      var rows = accts.map(function (a) { return categoryRow(cat, a); }).join('');
      var isOpex = cat.id === 'acct-bir-opex';
      var colspan = isOpex ? 5 : 4;
      var deductionHeader = isOpex ? '<th style="text-align:left;padding:5px 8px;font-weight:500;">Itemized Deduction</th>' : '';
      var emptyMsg = !accts.length ? '<tr><td colspan="' + colspan + '" style="padding:6px 8px;"><span class="muted">No accounts mapped to ' + esc(cat.label.toLowerCase()) + ' yet.</span></td></tr>' : '';
      return heading +
        (isOpex ? '<p style="font-size:11px;color:#6b7280;margin:0 0 6px;">Each expense account also gets an <strong>Itemized Deduction</strong> category (BIR Schedule 4 / Schedule I), so 1701/1701Q/1702Q/1702RT pick it up automatically.</p>' : '') +
        '<div style="overflow-x:auto;margin-bottom:8px;"><table id="' + tableId + '" style="width:100%;border-collapse:collapse;">' +
        '<thead><tr style="font-size:11px;color:#9ca3af;">' +
        '<th style="text-align:left;padding:5px 8px;font-weight:500;">Account</th>' +
        '<th style="text-align:left;padding:5px 8px;font-weight:500;">Group</th>' +
        '<th style="padding:5px 8px;font-weight:500;">BIR Category</th>' +
        deductionHeader +
        '<th></th></tr></thead><tbody>' + rows + emptyMsg + '</tbody></table></div>';
    }

    function renderUnmappedTable() {
      var unmapped = Object.values(coa).filter(function (a) { return !coaMap[a.key]; })
        .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
      var tableId = 'coa-unmapped-tbl';
      var heading = '<h3 style="margin:20px 0 6px;font-size:13px;font-weight:500;color:#b45309;display:flex;align-items:center;gap:10px;">' +
        '<span>⚠ Not yet mapped</span>' +
        (unmapped.length ? '<button data-action="coa-save-all" data-table="' + tableId + '" style="font-size:11px;padding:3px 12px;border:1px solid #d1d5db;border-radius:5px;background:#fff;cursor:pointer;">Save All</button>' : '') +
        '</h3>';
      if (!unmapped.length) return heading + '<p class="muted">All accounts are mapped.</p>';
      var rows = unmapped.map(function (a) {
        var defaultCat = a.isProfitAndLossAccount ? 'acct-bir-opex' : 'acct-bir-asset';
        var catOpts = BIR_COA_CATEGORIES
          .filter(function (c) { return c.isPnL === a.isProfitAndLossAccount; })
          .map(function (c) {
            var sel = c.id === defaultCat ? ' selected' : '';
            return '<option value="' + esc(c.id) + '"' + sel + '>' + esc(c.label) + '</option>';
          }).join('');
        return '<tr data-key="' + esc(a.key) + '" style="border-bottom:.5px solid #f3f4f6;">' +
          '<td style="padding:6px 8px;"><input data-role="name" type="text" value="' + esc(a.name) + '" style="font-size:12px;width:100%;border:1px solid #e5e7eb;border-radius:4px;padding:3px 6px;" /></td>' +
          '<td style="padding:6px 8px;font-size:12px;color:#6b7280;">' + esc(groupNameFor(a.group, a.isProfitAndLossAccount)) + '</td>' +
          '<td style="padding:6px 8px;"><select data-role="cat" style="width:100%;font-size:12px;"><option value="">-- pick category --</option>' + catOpts + '</select></td>' +
          '<td style="padding:6px 8px;"><button class="btn btn-primary btn-sm" data-action="coa-save-row" style="font-size:11px;">Save</button></td>' +
          '</tr>';
      }).join('');
      return heading +
        '<div style="overflow-x:auto;margin-bottom:8px;"><table id="' + tableId + '" style="width:100%;border-collapse:collapse;">' +
        '<thead><tr style="font-size:11px;color:#9ca3af;">' +
        '<th style="text-align:left;padding:5px 8px;font-weight:500;">Account</th>' +
        '<th style="text-align:left;padding:5px 8px;font-weight:500;">Group</th>' +
        '<th style="padding:5px 8px;font-weight:500;">BIR Category</th>' +
        '<th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    }

    // Shared by single-row Save and Save All: persists one row's name/category
    // edit, or creates a brand-new account (+ group, if "+ New group..." was
    // picked) for rows added via "+ Add Account". mapDirty lets Save All batch
    // the coaMap write into one call instead of one saveCoaMapping per row.
    // deductionDirty does the same for the Operating Expenses itemized-
    // deduction sub-category (only present when the row has a [data-role="deduction"]
    // select, i.e. it's in the Operating Expenses category table).
    async function saveRow(business, row, mapDirty, deductionDirty) {
      if (row.dataset.new === 'true') {
        await createRow(business, row, mapDirty, deductionDirty);
        return;
      }

      var guid = row.dataset.key;
      var acct = coa[guid];
      if (!acct) return;

      var newName = (row.querySelector('[data-role="name"]').value || '').trim();
      var newCat = row.querySelector('[data-role="cat"]').value || '';

      if (newName && newName !== acct.name) {
        var endpoint = acct.isProfitAndLossAccount ? '/api4/profit-and-loss-statement-account' : '/api4/balance-sheet-account';
        await apiRequest('PUT', endpoint, {
          business: business,
          key: guid,
          value: { name: newName, group: acct.group || null },
        });
        acct.name = newName;
        invalidateCoaCache(business);
      }
      if (newCat) {
        mapDirty[guid] = newCat;
      } else {
        delete mapDirty[guid];
      }

      var deductionSel = row.querySelector('[data-role="deduction"]');
      if (deductionSel) deductionDirty[guid] = deductionSel.value;
    }

    // Creates a new account (and optionally a new group) for a blank row
    // added via "+ Add Account". Manager requires every account to belong to
    // a real group/subgroup -- it can't attach directly to the Asset/
    // Liabilities/Equity/etc. "father" groups, or it silently lands under
    // Equity > Uncategorized -- so a real group selection (or a freshly
    // created one) is mandatory here.
    async function createRow(business, row, mapDirty, deductionDirty) {
      var cat = catById(row.dataset.cat);
      var name = (row.querySelector('[data-role="name"]').value || '').trim();
      var groupSel = row.querySelector('[data-role="newgroup"]');
      var groupVal = groupSel.value;
      var newGroupName = (row.querySelector('[data-role="newgroupname"]').value || '').trim();
      if (!cat) return;
      if (!name) throw new Error('Please enter an account name for "' + cat.label + '".');
      if (groupVal === '__new__' && !newGroupName) throw new Error('Please enter a name for the new group under "' + cat.label + '".');
      if (!groupVal) throw new Error('Please pick a Group for "' + name + '", or choose "+ New group...".');

      var masterGuid = NATIVE_MASTER_GROUP[cat.id] || null;
      var groupGuid = groupVal;
      if (groupVal === '__new__') {
        var groupEndpoint = cat.isPnL ? '/api4/profit-and-loss-statement-group' : '/api4/balance-sheet-group';
        var groupCreateValue = { name: newGroupName };
        if (masterGuid) groupCreateValue.group = masterGuid;
        var createdGroup = await apiRequest('POST', groupEndpoint, { business: business, value: groupCreateValue });
        groupGuid = (createdGroup && (createdGroup.key || createdGroup.Key)) || null;
        if (!groupGuid) {
          invalidateAccountGroupsCache(business);
          var freshGroups = await loadAccountGroups(business, true);
          var foundGroup = (cat.isPnL ? freshGroups.pnl : freshGroups.bs)
            .find(function (g) { return (g.name || '').toLowerCase() === newGroupName.toLowerCase(); });
          groupGuid = foundGroup ? foundGroup.key : null;
        }
        if (!groupGuid) throw new Error('Could not create group "' + newGroupName + '".');
        invalidateAccountGroupsCache(business);
        groups = await loadAccountGroups(business, true);
      }

      var acctEndpoint = cat.isPnL ? '/api4/profit-and-loss-statement-account' : '/api4/balance-sheet-account';
      var createdAcct = await apiRequest('POST', acctEndpoint, { business: business, value: { name: name, group: groupGuid } });
      var acctGuid = (createdAcct && (createdAcct.key || createdAcct.Key)) || null;
      if (!acctGuid) {
        invalidateCoaCache(business);
        var freshCoa = await loadChartOfAccounts(business, true);
        var foundAcct = Object.values(freshCoa).find(function (a) {
          return (a.name || '').toLowerCase() === name.toLowerCase() && a.isProfitAndLossAccount === cat.isPnL;
        });
        acctGuid = foundAcct ? foundAcct.key : null;
      }
      if (!acctGuid) throw new Error('"' + name + '" may have been created in Manager, but could not be found to map it — please refresh and map it manually.');

      invalidateCoaCache(business);
      mapDirty[acctGuid] = cat.id;

      var deductionSel = row.querySelector('[data-role="deduction"]');
      if (deductionSel) deductionDirty[acctGuid] = deductionSel.value;
    }

    async function onSaveRow(e) {
      var btn = e.currentTarget;
      var row = btn.closest('tr');
      var business = biz();
      if (!business) return;

      var deductionDirty = {};
      try {
        await saveRow(business, row, coaMap, deductionDirty);
        await saveCoaMapping(business, coaMap);
        persistDeductionDirty(business, deductionDirty);
        flash(btn, true);
        await refresh();
      } catch (err) {
        console.error(err);
        flash(btn, false);
        alert(err.message);
      }
    }

    async function onSaveAll(e) {
      var btn = e.currentTarget;
      var table = document.getElementById(btn.dataset.table);
      var business = biz();
      if (!business || !table) return;

      var rows = table.querySelectorAll('tbody tr');
      var deductionDirty = {};
      btn.textContent = 'Saving…';
      btn.disabled = true;
      try {
        for (var i = 0; i < rows.length; i++) {
          await saveRow(business, rows[i], coaMap, deductionDirty);
        }
        await saveCoaMapping(business, coaMap);
        persistDeductionDirty(business, deductionDirty);
        flash(btn, true);
        await refresh();
      } catch (err) {
        console.error(err);
        flash(btn, false);
        btn.disabled = false;
        alert(err.message);
      }
    }

    function persistDeductionDirty(business, deductionDirty) {
      if (!Object.keys(deductionDirty).length || typeof saveDeductionOverrides !== 'function') return;
      Object.assign(deductionOverrides, deductionDirty);
      saveDeductionOverrides(business, deductionOverrides);
    }

    function showToastSafe(msg) {
      if (typeof showToast === 'function') showToast(msg, 'success');
    }

    return { refresh: refresh };
  }

  // ---- PUBLIC API ----
  window.COA = {
    mount: mountCoaSection,
    CATEGORIES: BIR_COA_CATEGORIES,
    accountOptionsHtml: accountOptionsHtml,
  };

})();
