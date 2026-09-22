(() => {
    'use strict';
    const api = (typeof browser !== 'undefined' ? browser : chrome);

    // Настройки по умолчанию (если ничего не сохранено)
    const defaults = {
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

    // Загрузка сохранённых настроек (или значений по умолчанию)
    api.storage.local.get(defaults, (data) => {
        // Оценка
        const target = document.getElementById(`r${data.rating}`);
        if (target) target.checked = true;

        // Комментарий
        els.addComment.checked = data.addComment;
        els.commentText.value = data.commentText;
        els.commentText.disabled = !data.addComment;

        // Включено
        els.enabled.checked = data.enabled;
        updateStatus(data.enabled);
    });

    // Сохранение при изменении (навсегда)
    const save = (patch) => {
        api.storage.local.set(patch);
    };

    els.ratingInputs.forEach((input) => {
        input.addEventListener('change', () => {
            save({ rating: parseInt(input.value, 10) });
        });
    });

    els.addComment.addEventListener('change', () => {
        const value = els.addComment.checked;
        save({ addComment: value });
        els.commentText.disabled = !value;
        if (!value) els.commentText.value = '';
    });

        els.commentText.addEventListener('input', () => {
            save({ commentText: els.commentText.value });
        });

        els.enabled.addEventListener('change', () => {
            const value = els.enabled.checked;
            save({ enabled: value });
            updateStatus(value);
        });

        function updateStatus(enabled) {
            if (enabled) {
                els.status.classList.remove('disabled');
                els.statusText.textContent = 'Активно — ждём форму оценки';
            } else {
                els.status.classList.add('disabled');
                els.statusText.textContent = 'Приостановлено';
            }
        }
})();
