export function format(template, ...values) {
    let next = 0;
    return template.replace(/%[sd%]/g, token => token === '%%' ? '%' : `${values[next++]}`);
}
