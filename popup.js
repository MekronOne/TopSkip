(() => {
    'use strict';

    const api = typeof browser !== 'undefined' ? browser : chrome;

    const DEFAULTS = {
        rating: 5,
        addComment: false,
        commentText: '',
        enabled: true,
    };

    const els = {
        ratingInputs: document.querySelectorAll('input[name="rating"]'),
        addComment: document.getElementById('addComment'),
        commentText: document.getElementById('commentText'),
        enabled: document.getElementById('enabled'),
        status: document.getElementById('status'),
        statusText: document.querySelector('.status-text'),
    };

    function storageGet(defaults) {
        try {
            const result = api.storage.local.get(defaults);
            if (result && typeof result.then === 'function') return result;
        } catch (_) {
            // ниже используем callback-вариант
        }
        return new Promise((resolve) => api.storage.local.get(defaults, resolve));
    }

    function storageSet(patch) {
        try {
            const result = api.storage.local.set(patch);
            if (result && typeof result.then === 'function') return result;
        } catch (_) {
            // ниже используем callback-вариант
        }
        return new Promise((resolve) => api.storage.local.set(patch, resolve));
    }

    function save(patch) {
        return storageSet(patch).catch((error) => {
            console.warn('[Top Skip] Не удалось сохранить настройки:', error);
        });
    }

    function updateStatus(enabled) {
        if (!els.status || !els.statusText) return;

        if (enabled) {
            els.status.classList.remove('disabled');
            els.statusText.textContent = 'Активно';
        } else {
            els.status.classList.add('disabled');
            els.statusText.textContent = 'На паузе';
        }
    }

    function syncCommentState(enabled) {
        els.commentText.disabled = !enabled;
    }

    async function load() {
        let data = { ...DEFAULTS };

        try {
            data = { ...DEFAULTS, ...(await storageGet(DEFAULTS)) };
        } catch (error) {
            console.warn('[Top Skip] Не удалось загрузить настройки:', error);
        }

        const rating = Math.min(5, Math.max(1, Number(data.rating) || DEFAULTS.rating));
        const ratingInput = document.getElementById(`r${rating}`);
        if (ratingInput) ratingInput.checked = true;

        els.addComment.checked = Boolean(data.addComment);
        els.commentText.value = data.commentText || '';
        syncCommentState(els.addComment.checked);

        els.enabled.checked = Boolean(data.enabled);
        updateStatus(els.enabled.checked);
    }

    els.ratingInputs.forEach((input) => {
        input.addEventListener('change', () => {
            if (!input.checked) return;
            void save({ rating: Number(input.value) });
        });
    });

    els.addComment.addEventListener('change', () => {
        const enabled = els.addComment.checked;
        syncCommentState(enabled);
        void save({ addComment: enabled });
    });

    els.commentText.addEventListener('input', () => {
        void save({ commentText: els.commentText.value });
    });

    els.enabled.addEventListener('change', () => {
        const enabled = els.enabled.checked;
        updateStatus(enabled);
        void save({ enabled });
    });

    void load();
})();
