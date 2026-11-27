// ============================================================
// SHOPPING.SERVICE.JS — Dados e lógica de negócio da lista de compras
// Sem dependências de DOM. Importável por qualquer camada (web, testes, mobile).
// ============================================================

import { state } from '../../core/state/store.js';
import { generateId, toDateStr } from '../../utils/helpers.js';

// ===== CATÁLOGOS =====

export const STORES = {
  ayumi:   { name: 'Ayumi',   label: 'Ayumi Supermercados',  img: 'assets/images/ayumi.png',   color: '#1a56db' },
  assai:   { name: 'Assaí',   label: 'Assaí Atacadista',     img: 'assets/images/Assai.png',   color: '#e63312' },
  westboi: { name: 'Westboi', label: 'Westboi Açougue',      img: 'assets/images/westboi.png', color: '#b91c1c' },
  outro:   { name: 'Outro',   label: 'Outro mercado',        img: null,                        color: '#6B7280' }
};

export const SHOPPING_CATEGORIES = {
  frutas:     { label: 'Frutas & Verduras', icon: 'fa-apple-whole',        color: '#06D6A0' },
  carnes:     { label: 'Carnes & Frios',    icon: 'fa-drumstick-bite',     color: '#EF233C' },
  padaria:    { label: 'Padaria',           icon: 'fa-bread-slice',        color: '#F8961E' },
  bebidas:    { label: 'Bebidas',           icon: 'fa-bottle-water',       color: '#4CC9F0' },
  laticinios: { label: 'Laticínios',        icon: 'fa-cheese',             color: '#FFD166' },
  mercearia:  { label: 'Mercearia',         icon: 'fa-jar',                color: '#8338EC' },
  limpeza:    { label: 'Limpeza',           icon: 'fa-spray-can-sparkles', color: '#4361EE' },
  higiene:    { label: 'Higiene & Beleza',  icon: 'fa-pump-soap',          color: '#C9A84C' },
  casa:       { label: 'Casa & Utilidades', icon: 'fa-house',              color: '#0096C7' },
  pets:       { label: 'Pets',              icon: 'fa-paw',                color: '#FFA500' },
  outros:     { label: 'Outros',            icon: 'fa-box',                color: '#9CA3AF' }
};

export const QUICK_ITEMS = [
  { name: 'Arroz',            category: 'mercearia',  unit: 'kg'  },
  { name: 'Feijão',           category: 'mercearia',  unit: 'kg'  },
  { name: 'Macarrão',         category: 'mercearia',  unit: 'un'  },
  { name: 'Óleo',             category: 'mercearia',  unit: 'un'  },
  { name: 'Açúcar',           category: 'mercearia',  unit: 'kg'  },
  { name: 'Sal',              category: 'mercearia',  unit: 'un'  },
  { name: 'Café',             category: 'mercearia',  unit: 'un'  },
  { name: 'Farinha de Trigo', category: 'mercearia',  unit: 'kg'  },
  { name: 'Leite',            category: 'laticinios', unit: 'L'   },
  { name: 'Ovos',             category: 'mercearia',  unit: 'dz'  },
  { name: 'Manteiga',         category: 'laticinios', unit: 'un'  },
  { name: 'Queijo',           category: 'laticinios', unit: 'g'   },
  { name: 'Presunto',         category: 'carnes',     unit: 'g'   },
  { name: 'Frango',           category: 'carnes',     unit: 'kg'  },
  { name: 'Carne Moída',      category: 'carnes',     unit: 'kg'  },
  { name: 'Linguiça',         category: 'carnes',     unit: 'kg'  },
  { name: 'Pão',              category: 'padaria',    unit: 'un'  },
  { name: 'Pão de Forma',     category: 'padaria',    unit: 'un'  },
  { name: 'Banana',           category: 'frutas',     unit: 'kg'  },
  { name: 'Maçã',             category: 'frutas',     unit: 'kg'  },
  { name: 'Tomate',           category: 'frutas',     unit: 'kg'  },
  { name: 'Cebola',           category: 'frutas',     unit: 'kg'  },
  { name: 'Batata',           category: 'frutas',     unit: 'kg'  },
  { name: 'Alho',             category: 'frutas',     unit: 'un'  },
  { name: 'Alface',           category: 'frutas',     unit: 'un'  },
  { name: 'Água',             category: 'bebidas',    unit: 'L'   },
  { name: 'Refrigerante',     category: 'bebidas',    unit: 'L'   },
  { name: 'Suco',             category: 'bebidas',    unit: 'L'   },
  { name: 'Detergente',       category: 'limpeza',    unit: 'un'  },
  { name: 'Sabão em Pó',      category: 'limpeza',    unit: 'un'  },
  { name: 'Amaciante',        category: 'limpeza',    unit: 'un'  },
  { name: 'Desinfetante',     category: 'limpeza',    unit: 'un'  },
  { name: 'Água Sanitária',   category: 'limpeza',    unit: 'un'  },
  { name: 'Esponja',          category: 'limpeza',    unit: 'un'  },
  { name: 'Papel Higiênico',  category: 'higiene',    unit: 'pct' },
  { name: 'Sabonete',         category: 'higiene',    unit: 'un'  },
  { name: 'Shampoo',          category: 'higiene',    unit: 'un'  },
  { name: 'Pasta de Dente',   category: 'higiene',    unit: 'un'  },
  { name: 'Ração',            category: 'pets',       unit: 'kg'  }
];

export const MONTHS_PT_FULL = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

export function normalizeItemName(str) {
  return String(str || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Monta o catálogo de "Adicionar rápido" e autocomplete unindo:
 * 1) Todos os itens já cadastrados pelo usuário em qualquer mercado (priorizando o mercado atual e listas principais)
 * 2) Sugestões padrão de QUICK_ITEMS que ainda não estejam nos itens cadastrados
 */
export function buildQuickCatalog(lists = [], activeStore = null) {
  const byKey = new Map();

  // Ordena do mais recente/principal para o mais antigo
  const orderedLists = [...(lists || [])].sort((a, b) => {
    const ta = a.updatedAt || a.createdAt || '';
    const tb = b.updatedAt || b.createdAt || '';
    return tb.localeCompare(ta);
  });

  for (const list of orderedLists) {
    if (!list?.items?.length) continue;
    const isSameStore = Boolean(activeStore && activeStore !== 'outro' && list.store === activeStore);
    for (const item of list.items) {
      const cleanName = String(item?.name || '').trim();
      const key = normalizeItemName(cleanName);
      if (!key) continue;

      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, {
          name: cleanName,
          category: item.category || 'outros',
          unit: item.unit || 'un',
          quantity: item.quantity && item.quantity > 0 ? item.quantity : 1,
          price: item.price !== undefined && item.price !== null && item.price !== '' ? Number(item.price) : null,
          store: list.store || 'outro',
          stores: new Set([list.store || 'outro']),
          sameStore: isSameStore,
          fromPrincipal: Boolean(list.isPrincipal),
          fromUser: true
        });
      } else {
        existing.stores.add(list.store || 'outro');
        if (list.isPrincipal) existing.fromPrincipal = true;
        // Se encontrarmos versão do mesmo mercado aberto, usa a unidade/qtd/preço daquele mercado
        if (isSameStore && !existing.sameStore) {
          existing.sameStore = true;
          existing.store = list.store;
          existing.category = item.category || existing.category;
          existing.unit = item.unit || existing.unit;
          existing.quantity = item.quantity && item.quantity > 0 ? item.quantity : existing.quantity;
          if (item.price !== undefined && item.price !== null && item.price !== '') {
            existing.price = Number(item.price);
          }
        } else if (existing.price === null && item.price !== undefined && item.price !== null && item.price !== '') {
          existing.price = Number(item.price);
        }
      }
    }
  }

  const userItems = [...byKey.values()]
    .map(({ stores, ...rest }) => ({ ...rest, storeList: [...stores] }))
    .sort((a, b) => {
      if (a.sameStore !== b.sameStore) return a.sameStore ? -1 : 1;
      if (a.fromPrincipal !== b.fromPrincipal) return a.fromPrincipal ? -1 : 1;
      return a.name.localeCompare(b.name, 'pt-BR');
    });

  const defaults = [];
  for (const q of QUICK_ITEMS) {
    const key = normalizeItemName(q.name);
    if (byKey.has(key)) continue;
    defaults.push({
      name: q.name,
      category: q.category,
      unit: q.unit,
      quantity: 1,
      price: null,
      store: null,
      storeList: [],
      sameStore: false,
      fromPrincipal: false,
      fromUser: false
    });
  }

  return [...userItems, ...defaults];
}

// ===== PERSISTÊNCIA =====

export function loadLists() {
  return state.shoppingLists;
}

export function saveLists(lists) {
  state.shoppingLists = lists;
}

// ===== OPERAÇÕES DE LISTA =====

function cloneItems(items = []) {
  return items.map(item => ({
    ...item,
    id: generateId(),
    quantity: item.quantity && item.quantity > 0 ? item.quantity : 1,
    unit: item.unit || 'un',
    price: item.price !== undefined && item.price !== null && item.price !== '' ? Number(item.price) : null,
    checked: false
  }));
}

export function createList(name, storeKey, { isPrincipal = false, templateItems = null } = {}) {
  const now = new Date().toISOString();
  return {
    id: generateId(),
    name,
    store: storeKey || 'outro',
    createdAt: now,
    updatedAt: now,
    items: templateItems ? cloneItems(templateItems) : [],
    isPrincipal: Boolean(isPrincipal),
    status: 'active'
  };
}

export function createListFromTemplate(source, targetName) {
  const now = new Date().toISOString();
  return {
    id: generateId(),
    name: (targetName || '').trim() || source.name,
    store: source.store || 'outro',
    createdAt: now,
    updatedAt: now,
    items: cloneItems(source.items || []),
    isPrincipal: false,
    templateSourceId: source.id,
    status: 'active'
  };
}

export function reuseList(source) {
  return createListFromTemplate(source, `${source.name} (cópia)`);
}

export function togglePrincipal(list) {
  if (!list) return false;
  list.isPrincipal = !list.isPrincipal;
  list.updatedAt = new Date().toISOString();
  return list.isPrincipal;
}

// ===== OPERAÇÕES DE ITEM =====

export function addItem(list, name, category, unit, extra = {}) {
  const cleanName = String(name || '').trim();
  if (!cleanName) return;
  const targetKey = normalizeItemName(cleanName);
  const existing = list.items.find(i => normalizeItemName(i.name) === targetKey);
  const addQty = extra.quantity && Number(extra.quantity) > 0 ? Number(extra.quantity) : 1;
  const parsedPrice = extra.price !== undefined && extra.price !== null && extra.price !== '' && Number.isFinite(Number(extra.price))
    ? Number(extra.price)
    : null;

  if (existing) {
    existing.quantity = Math.round(((existing.quantity || 1) + 1) * 100) / 100;
    if ((existing.price === null || existing.price === undefined) && parsedPrice !== null) {
      existing.price = parsedPrice;
    }
  } else {
    list.items.push({
      id: generateId(),
      name: cleanName,
      category: category || 'outros',
      quantity: addQty,
      unit: unit || 'un',
      price: parsedPrice,
      checked: false
    });
  }
  list.updatedAt = new Date().toISOString();
}

export function toggleItem(list, itemId) {
  const item = list.items.find(i => i.id === itemId);
  if (item) {
    item.checked = !item.checked;
    list.updatedAt = new Date().toISOString();
  }
}

export function removeItem(list, itemId) {
  list.items = list.items.filter(i => i.id !== itemId);
  list.updatedAt = new Date().toISOString();
}

export function editItem(list, itemId, patch) {
  const item = list.items.find(i => i.id === itemId);
  if (!item) return;
  Object.assign(item, patch);
  list.updatedAt = new Date().toISOString();
}

// ===== CHECKOUT =====

const PAY_LABELS = { dinheiro: 'Dinheiro', cartao: 'Cartão', pix: 'Pix', vr: 'VR', va: 'VA' };

/**
 * Constrói o objeto de transação a partir do checkout da lista.
 * Puro — sem efeitos colaterais, sem DOM, sem Firebase.
 */
export function buildCheckoutTransaction({ list, totalValue, responsible, category, description, paymentMethod, familyId }) {
  const store = STORES[list.store] || STORES.outro;
  return {
    id: generateId(),
    type: 'saida',
    amount: totalValue,
    category,
    responsible: responsible || 'Família',
    date: toDateStr(new Date()),
    description: `🛒 ${description} — ${store.name} (${PAY_LABELS[paymentMethod] || paymentMethod})`,
    paymentMethod,
    familyId,
    createdAt: new Date().toISOString()
  };
}

export function finalizeList(list, totalSpent) {
  list.status = 'completed';
  list.completedAt = new Date().toISOString();
  list.updatedAt = list.completedAt;
  list.totalSpent = totalSpent || 0;
}
