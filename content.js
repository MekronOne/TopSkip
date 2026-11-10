(() => {
    'use strict';

    const api = typeof browser !== 'undefined' ? browser : chrome;

    const DEFAULTS = {
        rating: 5,
        addComment: false,
        commentText: '',
        enabled: true,
        blockLessonRating: false,
        blockAds: false,
        removeOverdue: false,
    };

    // Все ожидания привязаны к состоянию DOM, а не к фиксированным паузам.
    const TIMING = {
        poll: 50,
        ratingTimeout: 1200,
        ratingAttempts: 2,
        afterRating: 50,
        hoverSettle: 60,
        retryDelay: 50,
        commentSettle: 100,
        textareaTimeout: 1200,
        nextButtonTimeout: 1500,
        stepTransitionTimeout: 2000,
        sendButtonTimeout: 2000,
        formCloseTimeout: 800,
        scanDebounce: 40,
        scanAfterProcess: 120,
    };

    let settings = { ...DEFAULTS };
    let processing = false;
    let scanTimer = null;
    let observer = null;

    // Форма домашнего задания заполняется один раз и без отправки.
    const handledHomework = new WeakSet();

    // Каждый шаг формы оценки обрабатываем один раз.
    const handledRatings = new WeakSet();

    // Кнопки закрытия уже обработанных модальных окон.
    const closingAnnouncements = new WeakSet();
    const closingEvaluations = new WeakSet();

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

    async function waitFor(getValue, timeout = 1500, interval = TIMING.poll) {
        const deadline = Date.now() + timeout;

        while (Date.now() <= deadline) {
            const value = getValue();
            if (value) return value;
            await sleep(interval);
        }

        return null;
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
            blockLessonRating: Boolean(raw?.blockLessonRating),
            blockAds: Boolean(raw?.blockAds),
            removeOverdue: Boolean(raw?.removeOverdue),
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

    // === Визуальные фильтры ===

    const VISUAL_STYLE_ID = 'top-skip-visual-style';

    const VISUAL_STYLE = `
        /* Окно объявлений скрыто всегда, но закрывается через Angular. */
        .announcement-modal,
        .announcement-modal .modal-content {
            display: none !important;
        }

        body:has(.announcement-modal) .modal-backdrop {
            display: none !important;
        }

        /* Блокировка окна оценки занятия. */
        body.top-skip-block-rating .modal:has(.rating-block),
        body.top-skip-block-rating .modal-content:has(.rating-block) {
            display: none !important;
        }

        body.top-skip-block-rating:has(.modal .rating-block) .modal-backdrop {
            display: none !important;
        }

        /* Реклама и истории. */
        body.top-skip-block-ads .stories__list,
        body.top-skip-block-ads .stories__item,
        body.top-skip-block-ads img[src*="my-class-logo"],
        body.top-skip-block-ads img[src*="max-logo-2025"],
        body.top-skip-block-ads a:has(> img[src*="my-class-logo"]),
        body.top-skip-block-ads a:has(> img[src*="max-logo-2025"]) {
            display: none !important;
        }

        /* Просроченные домашние задания. */
        body.top-skip-remove-overdue .homework-item.top-skip-overdue {
            display: none !important;
        }
    `;

    function injectVisualStyle() {
        if (document.getElementById(VISUAL_STYLE_ID)) return;

        const style = document.createElement('style');
        style.id = VISUAL_STYLE_ID;
        style.textContent = VISUAL_STYLE;
        (document.head || document.documentElement).appendChild(style);
    }

    function applyVisualFilters() {
        injectVisualStyle();

        const body = document.body;
        if (!body) return;

        body.classList.toggle('top-skip-block-rating', Boolean(settings.blockLessonRating));
        body.classList.toggle('top-skip-block-ads', Boolean(settings.blockAds));
        body.classList.toggle('top-skip-remove-overdue', Boolean(settings.removeOverdue));

        for (const item of document.querySelectorAll('.homework-item')) {
            let overdue = false;

            if (settings.removeOverdue) {
                const text = normalizeText(item.textContent).toLowerCase();
                overdue = text.includes('истекший')
                    || text.includes('просроч')
                    || Boolean(item.querySelector('.count-expired'));
            }

            item.classList.toggle('top-skip-overdue', overdue);
        }
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

    function clickStar(ratingRoot, value) {
        const star = findStar(ratingRoot, value);
        if (!star) {
            console.warn(`[Top Skip] Не найдена звезда с оценкой ${value}`);
            return false;
        }

        mouseClick(star);
        return true;
    }

    /**
     * Сбрасывает hover-состояние рейтинга.
     * В RatingComponent на mouseleave вызывается reset(), который возвращает
     * value к preValue. После реального клика preValue уже равен выбранной
     * оценке, поэтому значение остаётся. Если же был только hover, значение
     * откатится к 0 — это позволяет отличить наведение от выбора.
     */
    function clearRatingHover(ratingRoot) {
        const slider = ratingRoot?.querySelector('[role="slider"]');
        if (!slider) return;

        const rect = slider.getBoundingClientRect();
        const base = {
            bubbles: false,
            cancelable: true,
            composed: true,
            view: window,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
            screenX: rect.left + rect.width / 2,
            screenY: rect.top + rect.height / 2,
            relatedTarget: document.body,
        };

        slider.dispatchEvent(new MouseEvent('mouseout', { ...base, bubbles: true }));
        slider.dispatchEvent(new MouseEvent('mouseleave', base));
    }

    /**
     * Кликает по звезде и ждёт, пока Angular зарегистрирует оценку.
     * aria-valuenow меняется и при наведении, поэтому одного значения мало:
     * после клика hover сбрасывается и проверяется, что оценка не откатилась.
     */
    async function applyRating(ratingRoot, value) {
        if (!ratingRoot) return false;

        for (let attempt = 0; attempt < TIMING.ratingAttempts; attempt += 1) {
            if (!clickStar(ratingRoot, value)) return false;

            const accepted = await waitFor(
                () => getRatingValue(ratingRoot) === value,
                TIMING.ratingTimeout,
                TIMING.poll
            );

            if (!accepted) {
                clearRatingHover(ratingRoot);
                await sleep(TIMING.retryDelay);
                continue;
            }

            // Если это было только наведение, reset() вернёт 0.
            clearRatingHover(ratingRoot);
            await sleep(TIMING.hoverSettle);

            if (getRatingValue(ratingRoot) === value) {
                // Даём Angular завершить текущий цикл change detection.
                await sleep(TIMING.afterRating);
                return true;
            }

            console.warn('[Top Skip] Оценка не зафиксировалась, повторяю клик');
            await sleep(TIMING.retryDelay);
        }

        return false;
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

    // === Автоматическое закрытие объявлений ===

    function closeAnnouncementModal() {
        const titles = document.querySelectorAll('.modal-content .modal-title');

        for (const title of titles) {
            const text = normalizeText(title.textContent).toLowerCase();
            if (!text.includes('непрочитанные объявления')) continue;

            const modal = title.closest('.modal-content');
            const closeButton = modal?.querySelector('.close-btn');
            if (!closeButton || closingAnnouncements.has(closeButton)) continue;

            // Окно скрыто CSS, поэтому не проверяем видимость: закрываем его
            // через Angular, чтобы сайт корректно снял блокировку.
            closingAnnouncements.add(closeButton);
            mouseClick(closeButton);
            console.log('[Top Skip] Закрыто окно с объявлениями');
            return true;
        }

        return false;
    }

    // === Блокировка окна оценки занятия ===

    function findEvaluationModal() {
        for (const modal of document.querySelectorAll('.modal-content')) {
            if (modal.closest('.announcement-modal')) continue;
            if (!modal.querySelector('.rating-block')) continue;
            if (!modal.querySelector('.confirm-evaluation')) continue;
            return modal;
        }

        return null;
    }

    function closeEvaluationModal(modal = findEvaluationModal()) {
        if (!modal) return false;

        const closeButton = modal.querySelector('.close-btn');
        if (!closeButton) return false;
        if (closingEvaluations.has(closeButton)) return false;

        closingEvaluations.add(closeButton);
        mouseClick(closeButton);
        console.log('[Top Skip] Окно оценки занятия закрыто');
        return true;
    }

    // === Поиск неоценённой формы ===

    function findPendingRating(scope = document) {
        const rootScope = scope?.querySelectorAll ? scope : document;
        const candidates = rootScope.querySelectorAll('.rating-block rating, .rating-block [role="slider"]');
        const seen = new Set();

        for (const candidate of candidates) {
            const ratingRoot = findRatingRoot(candidate);
            if (!ratingRoot || seen.has(ratingRoot) || !isVisible(ratingRoot)) continue;
            seen.add(ratingRoot);

            // Домашнее задание заполняется отдельно.
            if (ratingRoot.closest('hw-upload-homework')) continue;

            const ratingBlock = ratingRoot.closest('.rating-block') || ratingRoot;
            const root = findFormRoot(ratingBlock);
            if (!root?.querySelector('.confirm-evaluation')) continue;

            // aria-valuenow меняется и при наведении, поэтому ориентируемся
            // на уже обработанные DOM-узлы, а не только на значение атрибута.
            if (handledRatings.has(ratingRoot)) {
                if (getRatingValue(ratingRoot) === 0) {
                    handledRatings.delete(ratingRoot);
                } else {
                    continue;
                }
            }

            return { ratingBlock, ratingRoot, root };
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

        if (ratingRoot && getRatingValue(ratingRoot) === 0) {
            filled = clickStar(ratingRoot, clampRating(settings.rating)) || filled;
        }

        // Если Angular ещё не отрисовал поля, не помечаем форму обработанной.
        if (!filled) return;

        handledHomework.add(homework);
        console.log('[Top Skip] Домашнее задание заполнено. Отправку подтверждает пользователь.');
    }

    // === Основной сценарий оценки урока ===

    function automationAllowed() {
        return settings.enabled && !settings.blockLessonRating;
    }

    async function waitForFormClose(ratingBlock, root) {
        await waitFor(() => {
            if (!ratingBlock.isConnected || !isVisible(ratingBlock)) return true;
            const currentRoot = root?.isConnected ? root : document;
            return !findButton(currentRoot, 'Отправить');
        }, TIMING.formCloseTimeout, TIMING.poll);
    }

    async function processRatingForm(initial) {
        const rating = clampRating(settings.rating);
        let current = initial;
        let steps = 0;

        // У формы может быть два шага: оценка преподавателя, затем урока.
        while (steps < 4) {
            if (!automationAllowed()) {
                closeEvaluationModal();
                return;
            }

            const { ratingBlock, ratingRoot, root } = current;

            // 1. Звезда и ожидание подтверждения от Angular.
            const accepted = await applyRating(ratingRoot, rating);
            if (!accepted) {
                throw new Error('Angular не подтвердил оценку: значение рейтинга не зафиксировалось');
            }

            handledRatings.add(ratingRoot);

            if (!automationAllowed()) {
                closeEvaluationModal();
                return;
            }

            // 2. Комментарий на текущем шаге.
            if (settings.addComment && settings.commentText.trim()) {
                const textarea = await waitFor(
                    () => findCommentTextarea(root),
                    TIMING.textareaTimeout,
                    TIMING.poll
                );

                if (textarea) {
                    setTextareaValue(textarea, settings.commentText);
                    console.log('[Top Skip] Комментарий добавлен');
                    await sleep(TIMING.commentSettle);
                } else {
                    console.warn('[Top Skip] Поле комментария не найдено');
                }
            }

            if (!automationAllowed()) {
                closeEvaluationModal();
                return;
            }

            // 3. Определяем действие на текущем шаге.
            const sendButton = findButton(root, 'Отправить');
            const nextButton = findButton(root, 'Далее');

            if (sendButton && !nextButton) {
                mouseClick(sendButton);
                console.log('[Top Skip] Нажата кнопка «Отправить»');
                await waitForFormClose(ratingBlock, root);
                console.log('[Top Skip] Форма оценки закрыта');
                return;
            }

            let actionButton = nextButton;
            if (!actionButton) {
                actionButton = await waitFor(
                    () => findButton(root, 'Далее') || findButton(root, 'Отправить'),
                    TIMING.nextButtonTimeout,
                    TIMING.poll
                );
            }

            if (!actionButton) {
                throw new Error('Кнопка «Далее» или «Отправить» не найдена');
            }

            const isSend = normalizeText(actionButton.textContent) === 'Отправить';
            mouseClick(actionButton);
            console.log(isSend
                ? '[Top Skip] Нажата кнопка «Отправить»'
                : '[Top Skip] Нажата кнопка «Далее»');

            if (isSend) {
                await waitForFormClose(ratingBlock, root);
                console.log('[Top Skip] Форма оценки закрыта');
                return;
            }

            if (!automationAllowed()) {
                closeEvaluationModal();
                return;
            }

            // 4. Ждём следующий шаг: новую неоценённую форму или «Отправить».
            const nextState = await waitFor(() => {
                const pending = findPendingRating(root);
                if (pending) {
                    return { type: 'rating', pending };
                }

                const send = findButton(root, 'Отправить');
                if (send) {
                    return { type: 'send', button: send };
                }

                return null;
            }, TIMING.stepTransitionTimeout, TIMING.poll);

            if (!nextState) {
                throw new Error('Следующий шаг формы оценки не появился');
            }

            if (!automationAllowed()) {
                closeEvaluationModal();
                return;
            }

            if (nextState.type === 'send') {
                mouseClick(nextState.button);
                console.log('[Top Skip] Нажата кнопка «Отправить»');
                await waitForFormClose(ratingBlock, root);
                console.log('[Top Skip] Форма оценки закрыта');
                return;
            }

            current = nextState.pending;
            steps += 1;
        }

        throw new Error('Слишком много шагов формы оценки');
    }

    // === Планировщик ===

    function scheduleScan(delay = TIMING.scanDebounce) {
        if (scanTimer) clearTimeout(scanTimer);
        scanTimer = setTimeout(() => {
            scanTimer = null;
            void scan();
        }, delay);
    }

    async function scan() {
        // Визуальные фильтры работают независимо от автоматизации.
        applyVisualFilters();

        // Окно объявлений закрываем всегда, при любых настройках.
        if (closeAnnouncementModal()) return;

        // Блокировка окна оценки занятия тоже работает независимо.
        if (settings.blockLessonRating) {
            const evaluationModal = findEvaluationModal();
            if (evaluationModal && closeEvaluationModal(evaluationModal)) return;
        }

        if (!settings.enabled || processing) return;

        // Домашнее задание имеет приоритет и не отправляется автоматически.
        const homework = findVisibleHomework();
        if (homework) {
            fillHomework(homework);
            return;
        }

        // При включённой блокировке не запускаем автоматическую оценку.
        if (settings.blockLessonRating) return;

        const pending = findPendingRating();
        if (!pending) return;

        processing = true;
        try {
            await processRatingForm(pending);
        } catch (error) {
            console.warn('[Top Skip]', error);
        } finally {
            processing = false;
            scheduleScan(TIMING.scanAfterProcess);
        }
    }

    // === Запуск ===

    function startObserver() {
        if (observer || !document.body) return;

        observer = new MutationObserver(() => {
            scheduleScan(TIMING.scanDebounce);
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

        applyVisualFilters();
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
            applyVisualFilters();
            scheduleScan(TIMING.scanDebounce);
        });
    }

    void init();
})();
