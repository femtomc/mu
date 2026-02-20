local uv = vim.uv or vim.loop

local M = {}

local defaults = {
	server_url = nil,
	repo_root = nil,
	shared_secret = nil,
	shared_secret_env = { "MU_NEOVIM_SHARED_SECRET" },
	actor_id = nil,
	tenant_id = nil,
	conversation_id = nil,
	role = "operator",
	enable_mu_alias = true,
	auto_link_identity = false,
	request_timeout_ms = 120000,
	selection_max_chars = 12000,
	include_client_context = true,
	metadata = {},
	flash_session_kind = "cp_operator",
	ui = {
		mode = "panel", -- panel | float | notify
		use_float = nil, -- legacy alias (overrides mode when set)
		border = "rounded",
		width_ratio = 0.8,
		height_ratio = 0.65,
		panel_height = 14,
		panel_max_lines = 2000,
	},
	poll = {
		enabled = false,
		auto_start = true,
		interval_ms = 4000,
		limit = 80,
		sources = "cp_outbox,cp_commands",
		notify_errors = false,
		max_preview_chars = 240,
	},
}

local state = {
	opts = vim.deepcopy(defaults),
	command_registered = false,
	alias_registered = false,
	linked = false,
	panel = {
		bufnr = nil,
		winid = nil,
	},
	poll = {
		enabled = false,
		in_flight = false,
		loop_token = 0,
		last_ts_ms = nil,
		seen_ids = {},
		context_key = nil,
		context = nil,
	},
}

local function trim(value)
	if type(value) ~= "string" then
		return ""
	end
	return (value:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function notify(message, level)
	vim.notify(message, level or vim.log.levels.INFO, { title = "mu.nvim" })
end

local function path_join(left, right)
	if left:sub(-1) == "/" then
		return left .. right
	end
	return left .. "/" .. right
end

local function dirname(path)
	if vim.fs and vim.fs.dirname then
		return vim.fs.dirname(path)
	end
	return path:match("^(.*)/[^/]+$") or path
end

local function basename(path)
	if vim.fs and vim.fs.basename then
		return vim.fs.basename(path)
	end
	return path:match("([^/]+)$") or path
end

local function file_exists(path)
	return uv.fs_stat(path) ~= nil
end

local function read_file(path)
	local fd = io.open(path, "r")
	if not fd then
		return nil
	end
	local content = fd:read("*a")
	fd:close()
	return content
end

local function json_decode(raw)
	local ok, decoded = pcall(vim.json.decode, raw)
	if not ok then
		return nil
	end
	return decoded
end

local function json_encode(value)
	local ok, encoded = pcall(vim.json.encode, value)
	if not ok then
		return nil
	end
	return encoded
end

local function normalize_base_url(url)
	return url:gsub("/+$", "")
end

local function url_encode(value)
	local s = tostring(value)
	s = s:gsub("\n", "\r\n")
	s = s:gsub("([^%w%-_%.~])", function(char)
		return string.format("%%%02X", string.byte(char))
	end)
	return s
end

local function split_words(text)
	local out = {}
	for word in tostring(text):gmatch("%S+") do
		table.insert(out, word)
	end
	return out
end

local function find_repo_root(start_path)
	local cursor = start_path
	while cursor and #cursor > 0 do
		local discovery_path = path_join(cursor, ".mu/control-plane/server.json")
		if file_exists(discovery_path) then
			return cursor
		end
		local parent = dirname(cursor)
		if not parent or parent == cursor then
			break
		end
		cursor = parent
	end
	return nil
end

local function resolve_repo_root()
	local explicit = trim(state.opts.repo_root)
	if #explicit > 0 then
		return explicit
	end
	local cwd = vim.fn.getcwd()
	local discovered = find_repo_root(cwd)
	return discovered or cwd
end

local function read_server_discovery(repo_root)
	local path = path_join(repo_root, ".mu/control-plane/server.json")
	local raw = read_file(path)
	if not raw or #trim(raw) == 0 then
		return nil
	end
	local parsed = json_decode(raw)
	if type(parsed) ~= "table" then
		return nil
	end
	if type(parsed.url) ~= "string" or #trim(parsed.url) == 0 then
		return nil
	end
	return parsed
end

local function resolve_server_url(repo_root)
	local explicit = trim(state.opts.server_url)
	if #explicit > 0 then
		return normalize_base_url(explicit)
	end
	local discovery = read_server_discovery(repo_root)
	if not discovery then
		return nil
	end
	return normalize_base_url(discovery.url)
end

local function resolve_shared_secret()
	local explicit = trim(state.opts.shared_secret)
	if #explicit > 0 then
		return explicit
	end
	for _, name in ipairs(state.opts.shared_secret_env or {}) do
		local value = trim(vim.env[name])
		if #value > 0 then
			return value
		end
	end
	return nil
end

local function resolve_actor_id()
	if type(state.opts.actor_id) == "function" then
		local value = trim(state.opts.actor_id())
		if #value > 0 then
			return value
		end
	elseif type(state.opts.actor_id) == "string" then
		local value = trim(state.opts.actor_id)
		if #value > 0 then
			return value
		end
	end

	local user = trim(vim.env.USER or vim.env.USERNAME)
	if #user == 0 then
		user = "unknown"
	end
	local host = "localhost"
	if uv.os_gethostname then
		host = uv.os_gethostname() or host
	elseif vim.fn and vim.fn.hostname then
		local resolved = trim(vim.fn.hostname())
		if #resolved > 0 then
			host = resolved
		end
	end
	return string.format("nvim:%s@%s", user, host)
end

local function resolve_tenant_id(repo_root)
	if type(state.opts.tenant_id) == "function" then
		local value = trim(state.opts.tenant_id(repo_root))
		if #value > 0 then
			return value
		end
	elseif type(state.opts.tenant_id) == "string" then
		local value = trim(state.opts.tenant_id)
		if #value > 0 then
			return value
		end
	end
	return "workspace:" .. basename(repo_root)
end

local function resolve_conversation_id(tenant_id)
	if type(state.opts.conversation_id) == "function" then
		local value = trim(state.opts.conversation_id(tenant_id))
		if #value > 0 then
			return value
		end
	elseif type(state.opts.conversation_id) == "string" then
		local value = trim(state.opts.conversation_id)
		if #value > 0 then
			return value
		end
	end
	local tab = vim.api.nvim_tabpage_get_number(vim.api.nvim_get_current_tabpage())
	return string.format("nvim:%s:tab:%d", tenant_id, tab)
end

local function resolve_channel_context(opts)
	local repo_root = resolve_repo_root()
	local server_url = resolve_server_url(repo_root)
	if not server_url then
		return nil, "unable to discover mu server URL (.mu/control-plane/server.json missing and server_url unset)"
	end
	local tenant_id = resolve_tenant_id(repo_root)
	local conversation_id = resolve_conversation_id(tenant_id)
	local actor_id = resolve_actor_id()
	local shared_secret = nil
	if opts and opts.require_secret then
		shared_secret = resolve_shared_secret()
		if not shared_secret then
			return nil,
				"missing Neovim shared secret (set setup.shared_secret or MU_NEOVIM_SHARED_SECRET environment variable)"
		end
	end
	return {
		repo_root = repo_root,
		server_url = server_url,
		tenant_id = tenant_id,
		conversation_id = conversation_id,
		actor_id = actor_id,
		shared_secret = shared_secret,
	}, nil
end

local function context_key_from_ctx(ctx)
	return table.concat({ ctx.server_url, ctx.tenant_id, ctx.conversation_id }, "|")
end

local function reset_poll_tracking()
	state.poll.last_ts_ms = nil
	state.poll.seen_ids = {}
end

local function set_poll_context(ctx)
	local key = context_key_from_ctx(ctx)
	if state.poll.context_key ~= key then
		state.poll.context_key = key
		state.poll.context = {
			server_url = ctx.server_url,
			tenant_id = ctx.tenant_id,
			conversation_id = ctx.conversation_id,
		}
		reset_poll_tracking()
	end
end

local function collect_selection_context(cmd)
	if not cmd or (cmd.range or 0) == 0 then
		return nil
	end
	local line1 = tonumber(cmd.line1) or 0
	local line2 = tonumber(cmd.line2) or 0
	if line1 <= 0 or line2 <= 0 then
		return nil
	end
	if line1 > line2 then
		line1, line2 = line2, line1
	end
	local bufnr = vim.api.nvim_get_current_buf()
	local lines = vim.api.nvim_buf_get_lines(bufnr, line1 - 1, line2, false)
	local text = table.concat(lines, "\n")
	local max_chars = tonumber(state.opts.selection_max_chars) or defaults.selection_max_chars
	if #text > max_chars then
		text = text:sub(1, max_chars) .. "\n…[selection truncated]"
	end
	return {
		start_line = line1,
		end_line = line2,
		line_count = #lines,
		text = text,
	}
end

local function collect_client_context(repo_root, selection)
	local bufnr = vim.api.nvim_get_current_buf()
	local win = vim.api.nvim_get_current_win()
	local cursor = vim.api.nvim_win_get_cursor(win)
	local absolute_path = vim.api.nvim_buf_get_name(bufnr)
	local relative_path = absolute_path
	if #absolute_path > 0 and absolute_path:sub(1, #repo_root) == repo_root then
		relative_path = absolute_path:sub(#repo_root + 2)
	end

	local context = {
		editor = "neovim",
		cwd = vim.fn.getcwd(),
		repo_root = repo_root,
		buffer = {
			path = #absolute_path > 0 and absolute_path or nil,
			relative_path = #absolute_path > 0 and relative_path or nil,
			filetype = vim.bo[bufnr].filetype,
		},
		cursor = {
			line = cursor[1],
			col = cursor[2] + 1,
		},
		mode = vim.api.nvim_get_mode().mode,
	}
	if selection then
		context.selection = selection
	end
	return context
end

local function split_lines(text)
	if #text == 0 then
		return { "" }
	end
	return vim.split(text, "\n", { plain = true })
end

local function resolve_ui_mode()
	local ui = state.opts.ui or {}
	if type(ui.use_float) == "boolean" then
		return ui.use_float and "float" or "notify"
	end
	local mode = trim(ui.mode or "")
	if mode == "float" or mode == "notify" or mode == "panel" then
		return mode
	end
	return "panel"
end

local function open_float(title, text)
	local lines = split_lines(text)
	local max_width = 20
	for _, line in ipairs(lines) do
		max_width = math.max(max_width, vim.fn.strdisplaywidth(line))
	end

	local width = math.min(max_width + 2, math.floor(vim.o.columns * state.opts.ui.width_ratio))
	local height = math.min(#lines + 2, math.floor(vim.o.lines * state.opts.ui.height_ratio))
	local row = math.floor((vim.o.lines - height) / 2 - 1)
	local col = math.floor((vim.o.columns - width) / 2)

	local buf = vim.api.nvim_create_buf(false, true)
	vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
	vim.bo[buf].modifiable = false
	vim.bo[buf].bufhidden = "wipe"

	local win = vim.api.nvim_open_win(buf, true, {
		relative = "editor",
		style = "minimal",
		border = state.opts.ui.border,
		title = title,
		title_pos = "center",
		width = width,
		height = height,
		row = math.max(0, row),
		col = math.max(0, col),
	})

	vim.keymap.set("n", "q", function()
		if vim.api.nvim_win_is_valid(win) then
			vim.api.nvim_win_close(win, true)
		end
	end, { buffer = buf, silent = true, nowait = true })
end

local function ensure_panel_buffer()
	local bufnr = state.panel.bufnr
	if bufnr and vim.api.nvim_buf_is_valid(bufnr) then
		return bufnr
	end
	bufnr = vim.api.nvim_create_buf(false, true)
	pcall(vim.api.nvim_buf_set_name, bufnr, "mu://panel")
	vim.bo[bufnr].buftype = "nofile"
	vim.bo[bufnr].bufhidden = "hide"
	vim.bo[bufnr].swapfile = false
	vim.bo[bufnr].modifiable = false
	vim.bo[bufnr].filetype = "mu_panel"
	state.panel.bufnr = bufnr
	return bufnr
end

local function ensure_panel_window()
	local winid = state.panel.winid
	if winid and vim.api.nvim_win_is_valid(winid) then
		return winid
	end
	local bufnr = ensure_panel_buffer()
	local current = vim.api.nvim_get_current_win()
	local height = tonumber(state.opts.ui.panel_height) or defaults.ui.panel_height
	vim.cmd(string.format("botright %dsplit", math.max(3, height)))
	winid = vim.api.nvim_get_current_win()
	state.panel.winid = winid
	vim.api.nvim_win_set_buf(winid, bufnr)
	vim.wo[winid].number = false
	vim.wo[winid].relativenumber = false
	vim.wo[winid].wrap = false
	vim.wo[winid].signcolumn = "no"
	vim.wo[winid].cursorline = false
	vim.wo[winid].winfixheight = true
	if current and vim.api.nvim_win_is_valid(current) then
		vim.api.nvim_set_current_win(current)
	end
	return winid
end

local function show_panel()
	ensure_panel_window()
end

local function clear_panel()
	local bufnr = ensure_panel_buffer()
	vim.bo[bufnr].modifiable = true
	vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, {})
	vim.bo[bufnr].modifiable = false
end

local function hide_panel()
	local winid = state.panel.winid
	if winid and vim.api.nvim_win_is_valid(winid) then
		vim.api.nvim_win_close(winid, true)
	end
	state.panel.winid = nil
end

local function append_panel(title, text)
	local bufnr = ensure_panel_buffer()
	ensure_panel_window()

	local timestamp = os.date("%H:%M:%S")
	local lines = { string.format("[%s] %s", timestamp, title) }
	for _, line in ipairs(split_lines(text)) do
		table.insert(lines, "  " .. line)
	end
	table.insert(lines, "")

	vim.bo[bufnr].modifiable = true
	local existing = vim.api.nvim_buf_line_count(bufnr)
	vim.api.nvim_buf_set_lines(bufnr, existing, existing, false, lines)

	local max_lines = tonumber(state.opts.ui.panel_max_lines) or defaults.ui.panel_max_lines
	local total = vim.api.nvim_buf_line_count(bufnr)
	if total > max_lines then
		local trim_count = total - max_lines
		vim.api.nvim_buf_set_lines(bufnr, 0, trim_count, false, {})
	end
	vim.bo[bufnr].modifiable = false

	local winid = state.panel.winid
	if winid and vim.api.nvim_win_is_valid(winid) then
		local line_count = vim.api.nvim_buf_line_count(bufnr)
		pcall(vim.api.nvim_win_set_cursor, winid, { line_count, 0 })
	end
end

local function render_output(title, text, level)
	local mode = resolve_ui_mode()
	if mode == "float" then
		open_float(title, text)
		return
	end
	if mode == "panel" then
		append_panel(title, text)
		return
	end
	notify(text, level)
end

local function http_json_request(opts, callback)
	if type(vim.system) ~= "function" then
		callback({
			exit_code = 1,
			status = nil,
			body = "",
			json = nil,
			stderr = "vim.system is unavailable (requires Neovim >= 0.10)",
		})
		return
	end

	local marker = "__MU_HTTP_STATUS__:"
	local command = {
		"curl",
		"-sS",
		"-X",
		opts.method,
		opts.url,
		"-w",
		"\n" .. marker .. "%{http_code}",
		"--max-time",
		tostring(math.max(1, math.ceil((opts.timeout_ms or state.opts.request_timeout_ms) / 1000))),
	}

	for name, value in pairs(opts.headers or {}) do
		table.insert(command, "-H")
		table.insert(command, string.format("%s: %s", name, value))
	end

	local stdin = nil
	if opts.body ~= nil then
		table.insert(command, "--data-binary")
		table.insert(command, "@-")
		stdin = opts.body
	end

	vim.system(command, { text = true, stdin = stdin }, function(result)
		local stdout = result.stdout or ""
		local status = tonumber(stdout:match(marker .. "(%d%d%d)%s*$"))
		local body = stdout:gsub("\n" .. marker .. "%d%d%d%s*$", "")
		local decoded = nil
		if #trim(body) > 0 then
			decoded = json_decode(body)
		end
		vim.schedule(function()
			callback({
				exit_code = result.code,
				status = status,
				body = body,
				json = decoded,
				stderr = result.stderr or "",
			})
		end)
	end)
end

local function fetch_channel_capability(server_url, callback)
	http_json_request({
		method = "GET",
		url = server_url .. "/api/control-plane/channels",
		headers = {
			accept = "application/json",
		},
	}, function(response)
		if response.exit_code ~= 0 then
			callback(nil, string.format("failed to query channel capabilities: %s", trim(response.stderr)))
			return
		end
		if (response.status or 0) < 200 or (response.status or 0) >= 300 then
			callback(nil, string.format("capability request failed (HTTP %s): %s", response.status or "?", trim(response.body)))
			return
		end
		if type(response.json) ~= "table" or type(response.json.channels) ~= "table" then
			callback(nil, "server returned invalid channel capability payload")
			return
		end
		for _, capability in ipairs(response.json.channels) do
			if type(capability) == "table" and capability.channel == "neovim" then
				callback(capability, nil)
				return
			end
		end
		callback(nil, "server does not advertise neovim control-plane channel")
	end)
end

local function link_identity(callback)
	local ctx, err = resolve_channel_context({ require_secret = false })
	if err then
		callback(nil, err)
		return
	end

	local payload = {
		channel = "neovim",
		actor_id = ctx.actor_id,
		tenant_id = ctx.tenant_id,
		role = state.opts.role,
	}
	local encoded = json_encode(payload)
	if not encoded then
		callback(nil, "failed to encode identity link payload")
		return
	end

	http_json_request({
		method = "POST",
		url = ctx.server_url .. "/api/control-plane/identities/link",
		headers = {
			["content-type"] = "application/json",
			accept = "application/json",
		},
		body = encoded,
	}, function(response)
		if response.exit_code ~= 0 then
			callback(nil, string.format("identity link request failed: %s", trim(response.stderr)))
			return
		end
		if (response.status or 0) < 200 or (response.status or 0) >= 300 then
			callback(nil, string.format("identity link failed (HTTP %s): %s", response.status or "?", trim(response.body)))
			return
		end
		state.linked = true
		callback(response.json or { ok = true }, nil)
	end)
end

local function build_timeline_url(ctx)
	local params = {
		order = "asc",
		limit = tostring(state.opts.poll.limit),
		channel = "neovim",
		channel_tenant_id = ctx.tenant_id,
		channel_conversation_id = ctx.conversation_id,
		sources = state.opts.poll.sources,
	}
	if state.poll.last_ts_ms then
		params.since = tostring(state.poll.last_ts_ms + 1)
	end

	local query = {}
	for key, value in pairs(params) do
		if value ~= nil and tostring(value) ~= "" then
			table.insert(query, url_encode(key) .. "=" .. url_encode(value))
		end
	end
	return ctx.server_url .. "/api/context/timeline?" .. table.concat(query, "&")
end

local function should_render_polled_item(item)
	if type(item) ~= "table" then
		return false
	end
	local source = item.source_kind
	return source == "cp_outbox" or source == "cp_commands"
end

local function summarize_polled_item(item)
	local source = tostring(item.source_kind or "context")
	local preview = trim(item.preview or item.text or "")
	if #preview == 0 then
		preview = vim.inspect(item.metadata or {})
	end
	local max_chars = tonumber(state.opts.poll.max_preview_chars) or defaults.poll.max_preview_chars
	if #preview > max_chars then
		preview = preview:sub(1, max_chars) .. "…"
	end
	preview = preview:gsub("\n", " ⏎ ")
	return string.format("[%s] %s", source, preview)
end

local function poll_once(opts, done)
	if state.poll.in_flight then
		if done then
			done()
		end
		return
	end

	local ctx = opts and opts.context or state.poll.context
	if not ctx then
		local resolved, err = resolve_channel_context({ require_secret = false })
		if not resolved then
			if opts and not opts.silent_errors then
				notify(err, vim.log.levels.WARN)
			end
			if done then
				done()
			end
			return
		end
		ctx = {
			server_url = resolved.server_url,
			tenant_id = resolved.tenant_id,
			conversation_id = resolved.conversation_id,
		}
	end

	set_poll_context(ctx)
	state.poll.in_flight = true

	http_json_request({
		method = "GET",
		url = build_timeline_url(ctx),
		headers = {
			accept = "application/json",
		},
	}, function(response)
		state.poll.in_flight = false
		if response.exit_code ~= 0 then
			if (opts and not opts.silent_errors) or state.opts.poll.notify_errors then
				notify(string.format("mu tail poll failed: %s", trim(response.stderr)), vim.log.levels.WARN)
			end
			if done then
				done()
			end
			return
		end
		if (response.status or 0) < 200 or (response.status or 0) >= 300 then
			if (opts and not opts.silent_errors) or state.opts.poll.notify_errors then
				notify(
					string.format("mu tail poll rejected (HTTP %s): %s", response.status or "?", trim(response.body)),
					vim.log.levels.WARN
				)
			end
			if done then
				done()
			end
			return
		end

		if type(response.json) ~= "table" or type(response.json.items) ~= "table" then
			if (opts and not opts.silent_errors) or state.opts.poll.notify_errors then
				notify("mu tail poll returned invalid payload", vim.log.levels.WARN)
			end
			if done then
				done()
			end
			return
		end

		local new_lines = {}
		for _, item in ipairs(response.json.items) do
			if type(item) == "table" then
				local item_id = trim(tostring(item.id or ""))
				if #item_id == 0 then
					item_id = string.format("%s:%s", tostring(item.ts_ms or 0), trim(item.preview or ""))
				end
				local ts_ms = tonumber(item.ts_ms)
				if ts_ms and (not state.poll.last_ts_ms or ts_ms > state.poll.last_ts_ms) then
					state.poll.last_ts_ms = ts_ms
				end
				if not state.poll.seen_ids[item_id] then
					state.poll.seen_ids[item_id] = true
					if should_render_polled_item(item) then
						table.insert(new_lines, summarize_polled_item(item))
					end
				end
			end
		end

		if #new_lines > 0 then
			render_output("mu tail", table.concat(new_lines, "\n"), vim.log.levels.INFO)
		end

		if done then
			done()
		end
	end)
end

local function schedule_poll_loop(token)
	if not state.poll.enabled or token ~= state.poll.loop_token then
		return
	end
	poll_once({ silent_errors = true }, function()
		if not state.poll.enabled or token ~= state.poll.loop_token then
			return
		end
		vim.defer_fn(function()
			schedule_poll_loop(token)
		end, math.max(500, tonumber(state.opts.poll.interval_ms) or defaults.poll.interval_ms))
	end)
end

local function start_polling(opts)
	if state.poll.enabled then
		if not (opts and opts.silent) then
			notify("mu tail already running")
		end
		return
	end

	local context = opts and opts.context or nil
	if not context then
		local resolved, err = resolve_channel_context({ require_secret = false })
		if not resolved then
			notify(err, vim.log.levels.ERROR)
			return
		end
		context = {
			server_url = resolved.server_url,
			tenant_id = resolved.tenant_id,
			conversation_id = resolved.conversation_id,
		}
	end
	set_poll_context(context)

	state.poll.enabled = true
	state.poll.loop_token = state.poll.loop_token + 1
	local token = state.poll.loop_token
	if not (opts and opts.silent) then
		notify("mu tail polling enabled")
	end
	schedule_poll_loop(token)
end

local function stop_polling(opts)
	if not state.poll.enabled then
		if not (opts and opts.silent) then
			notify("mu tail already stopped")
		end
		return
	end
	state.poll.enabled = false
	state.poll.loop_token = state.poll.loop_token + 1
	if not (opts and opts.silent) then
		notify("mu tail polling disabled")
	end
end

local function tail_status_text()
	local context = state.poll.context
	local where = context and string.format("%s :: %s", context.tenant_id, context.conversation_id) or "(unset)"
	return table.concat({
		"mu tail status",
		string.format("enabled: %s", tostring(state.poll.enabled)),
		string.format("in_flight: %s", tostring(state.poll.in_flight)),
		string.format("context: %s", where),
		string.format("last_ts_ms: %s", tostring(state.poll.last_ts_ms)),
	}, "\n")
end

local function submit_command(command_text, cmd)
	local ctx, err = resolve_channel_context({ require_secret = true })
	if err then
		notify(err, vim.log.levels.ERROR)
		return
	end

	set_poll_context(ctx)

	local metadata = vim.tbl_deep_extend("force", {
		source = "mu.nvim",
		client = "neovim",
	}, type(state.opts.metadata) == "table" and state.opts.metadata or {})

	local selection = collect_selection_context(cmd)
	if selection then
		metadata.selection = {
			start_line = selection.start_line,
			end_line = selection.end_line,
			line_count = selection.line_count,
		}
	end

	local payload = {
		tenant_id = ctx.tenant_id,
		conversation_id = ctx.conversation_id,
		actor_id = ctx.actor_id,
		command_text = command_text,
		metadata = metadata,
	}
	if state.opts.include_client_context then
		payload.client_context = collect_client_context(ctx.repo_root, selection)
	end

	local encoded = json_encode(payload)
	if not encoded then
		notify("Failed to encode Neovim ingress payload.", vim.log.levels.ERROR)
		return
	end

	fetch_channel_capability(ctx.server_url, function(capability, capability_err)
		if capability_err then
			notify(capability_err, vim.log.levels.ERROR)
			return
		end

		local route = capability.route or "/webhooks/neovim"
		local secret_header = "x-mu-neovim-secret"
		if type(capability.verification) == "table" and capability.verification.kind == "shared_secret_header" then
			secret_header = capability.verification.secret_header or secret_header
		end

		local proceed = function()
			http_json_request({
				method = "POST",
				url = ctx.server_url .. route,
				headers = {
					["content-type"] = "application/json",
					accept = "application/json",
					[secret_header] = ctx.shared_secret,
				},
				body = encoded,
			}, function(response)
				if response.exit_code ~= 0 then
					notify(string.format("mu request failed: %s", trim(response.stderr)), vim.log.levels.ERROR)
					return
				end
				if (response.status or 0) < 200 or (response.status or 0) >= 300 then
					notify(
						string.format("mu request rejected (HTTP %s): %s", response.status or "?", trim(response.body)),
						vim.log.levels.ERROR
					)
					return
				end

				local message = response.body
				if type(response.json) == "table" then
					message = response.json.message or response.json.ack or vim.inspect(response.json)
				end
				render_output("mu", tostring(message), vim.log.levels.INFO)

				if state.opts.poll.auto_start then
					start_polling({
						silent = true,
						context = {
							server_url = ctx.server_url,
							tenant_id = ctx.tenant_id,
							conversation_id = ctx.conversation_id,
						},
					})
				end
			end)
		end

		if state.opts.auto_link_identity and not state.linked then
			link_identity(function(_, link_err)
				if link_err then
					notify("identity bootstrap failed: " .. link_err, vim.log.levels.WARN)
				end
				proceed()
			end)
			return
		end

		proceed()
	end)
end

local function show_help()
	local lines = {
		"mu.nvim",
		"",
		"Usage:",
		"  :Mu <command text>        Send command text to /webhooks/neovim",
		"  :'<,'>Mu <command text>   Send command with visual-range selection context",
		"  :Mu channels              Inspect control-plane channel capabilities",
		"  :Mu link                  Link current Neovim actor identity",
		"  :Mu panel [show|hide|clear]",
		"  :Mu tail [on|off|once|status]",
		"  :Mu turn <session_id> <message>",
		"  :Mu flash <session_id> <message> (legacy alias for turn)",
		"  :Mu help",
		"",
		"Notes:",
		"  - :Mu is the real user command (Neovim requires uppercase command names).",
		"  - :mu can be enabled as an abbreviation alias via setup({ enable_mu_alias = true }).",
	}
	render_output("mu help", table.concat(lines, "\n"))
end

local function show_channels()
	local ctx, err = resolve_channel_context({ require_secret = false })
	if err then
		notify(err, vim.log.levels.ERROR)
		return
	end

	http_json_request({
		method = "GET",
		url = ctx.server_url .. "/api/control-plane/channels",
		headers = {
			accept = "application/json",
		},
	}, function(response)
		if response.exit_code ~= 0 then
			notify(string.format("failed to read channels: %s", trim(response.stderr)), vim.log.levels.ERROR)
			return
		end
		if (response.status or 0) < 200 or (response.status or 0) >= 300 then
			notify(
				string.format("channel request failed (HTTP %s): %s", response.status or "?", trim(response.body)),
				vim.log.levels.ERROR
			)
			return
		end
		if type(response.json) ~= "table" then
			render_output("mu channels", response.body)
			return
		end
		render_output("mu channels", vim.inspect(response.json))
	end)
end

local function session_turn(args, cmd)
	local session_id, message = args:match("^%S+%s+(%S+)%s+(.+)$")
	if not session_id or not message then
		notify("usage: :Mu turn <session_id> <message>", vim.log.levels.WARN)
		return true
	end

	local ctx, err = resolve_channel_context({ require_secret = true })
	if err then
		notify(err, vim.log.levels.ERROR)
		return true
	end

	local selection = collect_selection_context(cmd)
	local client_context = nil
	if state.opts.include_client_context then
		client_context = collect_client_context(ctx.repo_root, selection)
	end

	local payload = {
		session_id = session_id,
		session_kind = state.opts.flash_session_kind,
		body = message,
		source = "neovim",
		metadata = {
			client = "neovim",
			conversation_id = ctx.conversation_id,
			tenant_id = ctx.tenant_id,
			selection = selection
					and {
						start_line = selection.start_line,
						end_line = selection.end_line,
						line_count = selection.line_count,
					}
				or nil,
			client_context = client_context,
		},
	}
	local encoded = json_encode(payload)
	if not encoded then
		notify("failed to encode session turn payload", vim.log.levels.ERROR)
		return true
	end

	fetch_channel_capability(ctx.server_url, function(capability, capability_err)
		if capability_err then
			notify(capability_err, vim.log.levels.ERROR)
			return
		end

		local secret_header = "x-mu-neovim-secret"
		if type(capability.verification) == "table" and capability.verification.kind == "shared_secret_header" then
			secret_header = capability.verification.secret_header or secret_header
		end

		local proceed = function()
			http_json_request({
				method = "POST",
				url = ctx.server_url .. "/api/control-plane/turn",
				headers = {
					["content-type"] = "application/json",
					accept = "application/json",
					[secret_header] = ctx.shared_secret,
				},
				body = encoded,
			}, function(response)
				if response.exit_code ~= 0 then
					notify(string.format("session turn request failed: %s", trim(response.stderr)), vim.log.levels.ERROR)
					return
				end
				if (response.status or 0) < 200 or (response.status or 0) >= 300 then
					notify(
						string.format("session turn rejected (HTTP %s): %s", response.status or "?", trim(response.body)),
						vim.log.levels.ERROR
					)
					return
				end

				if type(response.json) == "table" and type(response.json.turn) == "table" then
					local turn = response.json.turn
					local reply = trim(turn.reply or "")
					if #reply == 0 then
						reply = "(no assistant reply)"
					end
					local cursor = trim(turn.context_entry_id or "")
					local lines = {
						string.format("session: %s", session_id),
						cursor ~= "" and string.format("context_entry_id: %s", cursor) or "context_entry_id: (none)",
						"",
						reply,
					}
					render_output("mu turn", table.concat(lines, "\n"), vim.log.levels.INFO)
					return
				end

				render_output("mu turn", response.body, vim.log.levels.INFO)
			end)
		end

		if state.opts.auto_link_identity and not state.linked then
			link_identity(function(_, link_err)
				if link_err then
					notify("identity bootstrap failed: " .. link_err, vim.log.levels.WARN)
				end
				proceed()
			end)
			return
		end

		proceed()
	end)
	return true
end

local function handle_panel_command(words)
	local action = words[2] or "show"
	if action == "show" then
		show_panel()
		notify("mu panel shown")
		return true
	end
	if action == "hide" then
		hide_panel()
		notify("mu panel hidden")
		return true
	end
	if action == "clear" then
		clear_panel()
		notify("mu panel cleared")
		return true
	end
	notify("unknown panel action (use: show|hide|clear)", vim.log.levels.WARN)
	return true
end

local function handle_tail_command(words)
	local action = words[2] or "status"
	if action == "on" then
		start_polling({ silent = false })
		return true
	end
	if action == "off" then
		stop_polling({ silent = false })
		return true
	end
	if action == "once" then
		poll_once({ silent_errors = false }, function() end)
		return true
	end
	if action == "status" then
		render_output("mu tail", tail_status_text(), vim.log.levels.INFO)
		return true
	end
	notify("unknown tail action (use: on|off|once|status)", vim.log.levels.WARN)
	return true
end

local function complete_subcommands(arglead)
	local candidates = {
		"help",
		"channels",
		"link",
		"panel",
		"panel show",
		"panel hide",
		"panel clear",
		"tail",
		"tail on",
		"tail off",
		"tail once",
		"tail status",
		"turn ",
		"flash ",
	}
	local out = {}
	for _, candidate in ipairs(candidates) do
		if #arglead == 0 or candidate:sub(1, #arglead) == arglead then
			table.insert(out, candidate)
		end
	end
	return out
end

local function register_command()
	if state.command_registered then
		return
	end
	local ok, err = pcall(vim.api.nvim_create_user_command, "Mu", function(cmd)
		local args = trim(cmd.args or "")
		if #args == 0 or args == "help" then
			show_help()
			return
		end

		local words = split_words(args)
		local head = words[1]
		if head == "channels" then
			show_channels()
			return
		end
		if head == "link" then
			link_identity(function(payload, link_err)
				if link_err then
					notify(link_err, vim.log.levels.ERROR)
					return
				end
				render_output("mu link", vim.inspect(payload), vim.log.levels.INFO)
			end)
			return
		end
		if head == "panel" then
			handle_panel_command(words)
			return
		end
		if head == "tail" then
			handle_tail_command(words)
			return
		end
		if head == "turn" or head == "flash" then
			session_turn(args, cmd)
			return
		end

		submit_command(args, cmd)
	end, {
		desc = "mu control-plane bridge",
		nargs = "*",
		range = true,
		complete = complete_subcommands,
	})
	if not ok then
		notify("failed to register :Mu command: " .. tostring(err), vim.log.levels.ERROR)
		return
	end
	state.command_registered = true
end

local function register_lowercase_alias()
	if state.alias_registered or not state.opts.enable_mu_alias then
		return
	end
	vim.cmd("silent! cunabbrev mu")
	vim.cmd([[cnoreabbrev <expr> mu (getcmdtype() ==# ':' && getcmdline() ==# 'mu') ? 'Mu' : 'mu']])
	state.alias_registered = true
end

function M.setup(opts)
	state.opts = vim.tbl_deep_extend("force", vim.deepcopy(defaults), state.opts or {}, opts or {})
	register_command()
	register_lowercase_alias()
	if state.opts.poll.enabled then
		start_polling({ silent = true })
	end
	return state.opts
end

function M.bootstrap()
	return M.setup({})
end

function M.link()
	link_identity(function(payload, err)
		if err then
			notify(err, vim.log.levels.ERROR)
			return
		end
		render_output("mu link", vim.inspect(payload), vim.log.levels.INFO)
	end)
end

function M.send(command_text)
	submit_command(command_text, nil)
end

function M.tail_start()
	start_polling({ silent = false })
end

function M.tail_stop()
	stop_polling({ silent = false })
end

function M.tail_once()
	poll_once({ silent_errors = false }, function() end)
end

function M.panel_show()
	show_panel()
end

function M.panel_hide()
	hide_panel()
end

function M.panel_clear()
	clear_panel()
end

return M
