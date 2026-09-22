(() => {
    'use strict';
    const api = (typeof browser !== 'undefined' ? browser : chrome);

    let settings = {
        rating: 5,
        addComment: false,
        commentText: '',
        enabled: true,
    };

    // Загрузка настроек при старте
    api.storage.local.get(settings, (data) => {
        settings = { ...settings, ...data };
        console.log('[AutoRate] Настройки загружены:', settings);
        if (settings.enabled) processAll(); // запуск сразу, без задержки
    });

        // Реакция на изменение настроек в реальном времени
        api.storage.onChanged.addListener((changes) => {
            for (const key in changes) {
                settings[key] = changes[key].newValue;
            }
            if (settings.enabled) processAll();
        });

            // === Утилиты ===
            function triggerClick(el) {
                if (!el) return;
                el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            }

            function triggerInput(element, value) {
                if (!element) return;
                element.focus();
                element.value = value;
                element.dispatchEvent(new Event('input', { bubbles: true }));
                element.dispatchEvent(new Event('change', { bubbles: true }));
                element.dispatchEvent(new Event('blur', { bubbles: true }));
            }

            // Установка рейтинга (один клик, без повторов)
            function setRating(ratingEl, value) {
                const slider = ratingEl.querySelector('span[role="slider"]');
                const currentValue = slider ? parseInt(slider.getAttribute('aria-valuenow')) : 0;
                if (currentValue === value) return; // уже стоит нужная оценка

                const stars = ratingEl.querySelectorAll('span.bs-rating-star');
                const target = stars[value - 1];
                if (target) {
                    triggerClick(target);
                    console.log(`[AutoRate] Поставлена оценка ${value}`);
                }
            }

            // === Обработка окна ДЗ ===
            function processHomework() {
                const hwModal = document.querySelector('hw-upload-homework');
                if (!hwModal) return false;

                // 1. Заполняем время: часы = 1, минуты = 0
                const hoursInput = hwModal.querySelector('input[placeholder="чч"]');
                const minutesInput = hwModal.querySelector('input[placeholder="мм"]');
                if (hoursInput && hoursInput.value !== '1') {
                    triggerInput(hoursInput, '1');
                    console.log('[AutoRate] ДЗ: часы = 1');
                }
                if (minutesInput && minutesInput.value !== '0') {
                    triggerInput(minutesInput, '0');
                    console.log('[AutoRate] ДЗ: минуты = 0');
                }

                // 2. Ставим оценку в рейтинге ДЗ
                const hwRating = hwModal.querySelector('rating');
                if (hwRating) setRating(hwRating, settings.rating);

                // 3. СТОПЕР: кнопку "Отправить" НЕ нажимаем
                console.log('[AutoRate] ДЗ заполнено. Ожидание ручного подтверждения.');
                return true;
            }

            // === Обработка окна оценки урока ===
            function processLessonEvaluation() {
                const ratingBlocks = document.querySelectorAll('.rating-block rating');
                if (ratingBlocks.length === 0) return;

                // 1. Ставим оценку
                ratingBlocks.forEach(r => setRating(r, settings.rating));

                // 2. Комментарий (если включён в настройках)
                if (settings.addComment && settings.commentText.trim()) {
                    document.querySelectorAll('.comment-block-textarea').forEach(ta => {
                        if (!ta.value || ta.value.trim() === '') {
                            triggerInput(ta, settings.commentText);
                            console.log('[AutoRate] Комментарий добавлен');
                        }
                    });
                }

                // 3. Нажимаем "Далее" или "Отправить" с минимальной задержкой
                setTimeout(() => {
                    document.querySelectorAll('.confirm-evaluation button').forEach(btn => {
                        const text = btn.innerText.trim();
                        if (text === 'Далее' || text === 'Отправить') {
                            triggerClick(btn);
                            console.log(`[AutoRate] Нажата "${text}"`);
                        }
                    });
                }, 80); // минимальная задержка для Angular
            }

            // === Главный процесс ===
            function processAll() {
                if (!settings.enabled) return;

                // Сначала проверяем окно ДЗ (приоритет)
                if (processHomework()) return;

                // Если ДЗ нет — обрабатываем оценку урока
                processLessonEvaluation();
            }

            // MutationObserver с минимальным дебаунсом (50 мс = мгновенно)
            let debounceTimer;
            const observer = new MutationObserver(() => {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(processAll, 50);
            });
            observer.observe(document.body, { childList: true, subtree: true });

            // Первый запуск сразу при загрузке страницы
            processAll();
})();
