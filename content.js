(() => {
    'use strict';

    const api = typeof browser !== 'undefined' ? browser : chrome;

    const DEFAULTS = {
        rating: 5,
        addComment: false,
        commentText: '',
        enabled: true,
    };

    let settings = { ...DEFAULTS };
    let processing = false;
    let scanTimer = null;
    let observer = null;

    // Форма домашнего задания заполняется один раз и без отправки.
    const handledHomework = new WeakSet();

    // === Совместимость storage (callback в Chrome, Promise в Firefox) ===
    function storageGet(defaults) {
        try {
            const result = api.storage.local.get(defaults);
            if (result && typeof result.then === 'function') return result;
        } catch (_) {
            // ниже используем callback-вариант
        }
        return new Promise((resolve) => api.storage.local.get(defaults, resolve));
    }

    // === Утилиты ===

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function clampRating(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) return DEFAULTS.rating;
        return Math.min(5, Math.max(1, Math.round(number)));
    }

    function normalizeSettings(raw) {
        return {
            rating: clampRating(raw?.rating),
            addComment: Boolean(raw?.addComment),
            commentText: typeof raw?.commentText === 'string' ? raw.commentText : '',
            enabled: raw?.enabled !== false,
        };
    }

    function normalizeText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function isVisible(el) {
        if (!el || !el.isConnected) return false;

        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return false;
        }

        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function waitFor(getValue, timeout = 5000, interval = 100) {
        const deadline = Date.now() + timeout;

        return (async () => {
            while (Date.now() <= deadline) {
                const value = getValue();
                if (value) return value;
                await sleep(interval);
            }
            return null;
        })();
    }

    // Полный цикл мышиных событий. Одного .click() Angular/Zone.js недостаточно.
    function mouseClick(el) {
        if (!el) return false;

        el.focus?.();

        const rect = el.getBoundingClientRect();
        const clientX = rect.left + rect.width / 2;
        const clientY = rect.top + rect.height / 2;
        const base = {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            clientX,
            clientY,
            screenX: clientX,
            screenY: clientY,
            button: 0,
        };

        if (typeof PointerEvent === 'function') {
            el.dispatchEvent(new PointerEvent('pointerdown', {
                ...base,
                buttons: 1,
                pointerId: 1,
                pointerType: 'mouse',
                isPrimary: true,
            }));
        }

        el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));

        if (typeof PointerEvent === 'function') {
            el.dispatchEvent(new PointerEvent('pointerup', {
                ...base,
                buttons: 0,
                pointerId: 1,
                pointerType: 'mouse',
                isPrimary: true,
            }));
        }

        el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0, detail: 1 }));
        el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0, detail: 1 }));

        return true;
    }

    // Нативный setter нужен, чтобы Angular увидел изменение ngModel.
    function setNativeValue(element, value, prototype) {
        if (!element) return;

        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
        if (descriptor && descriptor.set) {
            descriptor.set.call(element, value);
        } else {
            element.value = value;
        }

        const inputEvent = typeof InputEvent === 'function'
            ? new InputEvent('input', {
                bubbles: true,
                composed: true,
                inputType: 'insertText',
                data: value,
            })
            : new Event('input', { bubbles: true, composed: true });

        element.dispatchEvent(inputEvent);
        element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    }

    function setTextareaValue(element, value) {
        if (!element) return;

        element.focus();
        setNativeValue(element, value, HTMLTextAreaElement.prototype);
        element.blur();
    }

    function setInputValue(element, value) {
        if (!element) return;

        element.focus();
        setNativeValue(element, value, HTMLInputElement.prototype);
        element.blur();
    }

    // === Работа с рейтингом ===

    function getRatingValue(ratingRoot) {
        const slider = ratingRoot?.querySelector('[role="slider"]');
        if (!slider) return null;

        const raw = slider.getAttribute('aria-valuenow');
        if (raw === null || raw === '') return null;

        const value = Number(raw);
        return Number.isFinite(value) ? value : null;
    }

    function findStar(ratingRoot, value) {
        if (!ratingRoot) return null;

        // Основной, проверенный на сайте вариант.
        const titledStar = ratingRoot.querySelector(`.bs-rating-star[title="${value}"]`);
        if (titledStar) {
            return titledStar.querySelector('button.rating-star')
                || titledStar.querySelector('button')
                || titledStar;
        }

        // На случай, если title висит прямо на кнопке.
        const titledButton = ratingRoot.querySelector(`button[title="${value}"]`);
        if (titledButton) return titledButton;

        // Резерв: звёзды идут по порядку 1..5.
        const starButtons = Array.from(
            ratingRoot.querySelectorAll('.bs-rating-star button.rating-star, button.rating-star')
        );
        if (starButtons.length) return starButtons[value - 1] || null;

        const stars = Array.from(ratingRoot.querySelectorAll('.bs-rating-star'));
        return stars[value - 1] || null;
    }

    function setRating(ratingRoot, value) {
        if (!ratingRoot) return false;

        const current = getRatingValue(ratingRoot);
        if (current !== null && current !== 0) return true;

        const star = findStar(ratingRoot, value);
        if (!star) {
            console.warn(`[Top Skip] Не найдена звезда с оценкой ${value}`);
            return false;
        }

        mouseClick(star);
        console.log(`[Top Skip] Выбрана оценка ${value}`);
        return true;
    }

    function findRatingRoot(block) {
        if (!block) return null;
        if (block.matches('rating')) return block;
        return block.querySelector('rating') || block.closest('rating');
    }

    function findFormRoot(ratingBlock) {
        if (!ratingBlock) return document.body;

        const dialog = ratingBlock.closest(
            '[role="dialog"], .modal, .modal-dialog, .modal-content, .cdk-overlay-pane, .offcanvas'
        );
        if (dialog && dialog !== document.body) return dialog;

        // .rating-block и .confirm-evaluation — соседи внутри модального окна.
        let node = ratingBlock.parentElement;
        const fallback = node || document.body;

        for (let depth = 0; node && node !== document.body && depth < 10; depth += 1) {
            if (node.querySelector('.confirm-evaluation')) return node;
            node = node.parentElement;
        }

        return fallback;
    }

    function findButton(root, label) {
        const scopes = [];
        if (root?.querySelectorAll) scopes.push(root);
        if (!scopes.includes(document)) scopes.push(document);

        for (const scope of scopes) {
            const buttons = scope.querySelectorAll('.confirm-evaluation button');
            for (const button of buttons) {
                if (
                    normalizeText(button.textContent) === label
                    && !button.disabled
                    && isVisible(button)
                ) {
                    return button;
                }
            }
        }

        return null;
    }

    function findCommentTextarea(root) {
        const scopes = [];
        if (root?.querySelector) scopes.push(root);
        scopes.push(document);

        for (const scope of scopes) {
            const textareas = scope.querySelectorAll('textarea.comment-block-textarea');
            for (const textarea of textareas) {
                if (isVisible(textarea)) return textarea;
            }
        }

        return null;
    }

    // === Поиск неоценённой формы ===

    function findPendingRating() {
        const candidates = document.querySelectorAll('.rating-block rating, .rating-block [role="slider"]');
        const seen = new Set();

        for (const candidate of candidates) {
            const ratingRoot = findRatingRoot(candidate);
            if (!ratingRoot || seen.has(ratingRoot) || !isVisible(ratingRoot)) continue;
            seen.add(ratingRoot);

            const value = getRatingValue(ratingRoot);
            // aria-valuenow = 0 — форма ещё не оценена именно нами.
            if (value !== 0 && value !== null) continue;

            const ratingBlock = ratingRoot.closest('.rating-block') || ratingRoot;
            return {
                ratingBlock,
                ratingRoot,
                root: findFormRoot(ratingBlock),
            };
        }

        return null;
    }

    // === Домашнее задание: только заполнение, без отправки ===

    function findVisibleHomework() {
        const homework = document.querySelector('hw-upload-homework');
        return homework && isVisible(homework) ? homework : null;
    }

    function fillHomework(homework) {
        if (!homework || handledHomework.has(homework)) return;

        const hours = homework.querySelector('input[placeholder="чч"]');
        const minutes = homework.querySelector('input[placeholder="мм"]');
        const ratingRoot = homework.querySelector('rating');
        let filled = false;

        if (hours && hours.value !== '1') {
            setInputValue(hours, '1');
            filled = true;
        }

        if (minutes && minutes.value !== '0') {
            setInputValue(minutes, '0');
            filled = true;
        }

        if (ratingRoot) {
            filled = setRating(ratingRoot, clampRating(settings.rating)) || filled;
        }

        // Если Angular ещё не отрисовал поля, не помечаем форму обработанной.
        if (!filled) return;

        handledHomework.add(homework);
        console.log('[Top Skip] Домашнее задание заполнено. Отправку подтверждает пользователь.');
    }

    // === Основной сценарий оценки урока ===

    async function processRatingForm({ ratingBlock, ratingRoot, root }) {
        const rating = clampRating(settings.rating);

        // 1. Звезда.
        if (getRatingValue(ratingRoot) === 0 || getRatingValue(ratingRoot) === null) {
            if (!setRating(ratingRoot, rating)) {
                throw new Error('Не удалось найти звезду рейтинга');
            }

            await waitFor(() => {
                const value = getRatingValue(ratingRoot);
                return value !== null && value !== 0;
            }, 3000, 50);
        }

        if (!settings.enabled) return;

        // 2. Комментарий.
        if (settings.addComment && settings.commentText.trim()) {
            const textarea = findCommentTextarea(root)
                || await waitFor(() => findCommentTextarea(root), 2000, 100);

            if (textarea) {
                setTextareaValue(textarea, settings.commentText);
                console.log('[Top Skip] Комментарий добавлен');
                await sleep(80);
            } else {
                console.warn('[Top Skip] Поле комментария не найдено');
            }
        }

        if (!settings.enabled) return;

        // 3. «Далее».
        const nextButton = findButton(root, 'Далее')
            || await waitFor(() => findButton(root, 'Далее'), 4000, 100);

        if (nextButton) {
            mouseClick(nextButton);
            console.log('[Top Skip] Нажата кнопка «Далее»');
            await sleep(150);
        }

        if (!settings.enabled) return;

        // 4. «Отправить» появляется после «Далее».
        const sendButton = findButton(root, 'Отправить')
            || await waitFor(() => findButton(root, 'Отправить'), 8000, 100);

        if (!sendButton) {
            throw new Error('Кнопка «Отправить» не появилась');
        }

        mouseClick(sendButton);
        console.log('[Top Skip] Нажата кнопка «Отправить»');

        // 5. Ждём закрытия формы, чтобы не обработать её повторно.
        await sleep(200);
        await waitFor(() => {
            if (!ratingBlock.isConnected || !isVisible(ratingBlock)) return true;
            const currentRoot = root?.isConnected ? root : document;
            return !findButton(currentRoot, 'Отправить');
        }, 12000, 200);

        console.log('[Top Skip] Форма оценки закрыта');
    }

    // === Планировщик ===

    function scheduleScan(delay = 80) {
        if (scanTimer) clearTimeout(scanTimer);
        scanTimer = setTimeout(() => {
            scanTimer = null;
            void scan();
        }, delay);
    }

    async function scan() {
        if (!settings.enabled || processing) return;

        // Домашнее задание имеет приоритет и не отправляется автоматически.
        const homework = findVisibleHomework();
        if (homework) {
            fillHomework(homework);
            return;
        }

        const pending = findPendingRating();
        if (!pending) return;

        processing = true;
        try {
            await processRatingForm(pending);
        } catch (error) {
            console.warn('[Top Skip]', error);
        } finally {
            processing = false;
            scheduleScan(250);
        }
    }

    // === Запуск ===

    function startObserver() {
        if (observer || !document.body) return;

        observer = new MutationObserver(() => {
            scheduleScan(60);
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['aria-valuenow', 'aria-valuetext'],
        });
    }

    async function init() {
        try {
            const stored = await storageGet(DEFAULTS);
            settings = normalizeSettings({ ...DEFAULTS, ...stored });
        } catch (error) {
            console.warn('[Top Skip] Не удалось загрузить настройки:', error);
        }

        console.log('[Top Skip] Настройки загружены:', settings);

        startObserver();
        scheduleScan(0);

        api.storage.onChanged.addListener((changes, areaName) => {
            if (areaName && areaName !== 'local') return;

            let changed = false;
            for (const key of Object.keys(DEFAULTS)) {
                if (changes[key]) {
                    settings[key] = changes[key].newValue;
                    changed = true;
                }
            }

            if (!changed) return;
            settings = normalizeSettings(settings);
            scheduleScan(80);
        });
    }

    void init();
})();
