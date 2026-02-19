if vim.g.loaded_mu_nvim == 1 then
	return
end
vim.g.loaded_mu_nvim = 1

local ok, mu = pcall(require, "mu")
if not ok then
	vim.notify("mu.nvim failed to load: " .. tostring(mu), vim.log.levels.ERROR, { title = "mu.nvim" })
	return
end

mu.bootstrap()
