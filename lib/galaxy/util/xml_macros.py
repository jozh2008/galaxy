import os
from copy import deepcopy

from galaxy.util import parse_xml

REQUIRED_PARAMETER = object()


def load_with_references(path):
    """Load XML documentation from file system and preprocesses XML macros.

    Return the XML representation of the expanded tree and paths to
    referenced files that were imported (macros).
    """
    tree = raw_xml_tree(path)
    root = tree.getroot()

    macro_paths = _import_macros(root, path)

    # Collect tokens
    tokens = _macros_of_type(root, 'token', lambda el: el.text or '')
    tokens = expand_nested_tokens(tokens)

    # Expand xml macros
    macro_dict = _macros_of_type(root, 'xml', lambda el: XmlMacroDef(el))
    _expand_macros([root], macro_dict, tokens)
    for el in root.xpath('//macro'):
        if el.get('type') != 'template':
            # Only keep template macros
            el.getparent().remove(el)
    _expand_tokens_for_el(root, tokens)
    return tree, macro_paths


def load(path):
    tree, _ = load_with_references(path)
    return tree


def template_macro_params(root):
    """
    Look for template macros and populate param_dict (for cheetah)
    with these.
    """
    param_dict = {}
    macro_dict = _macros_of_type(root, 'template', lambda el: el.text)
    for key, value in macro_dict.items():
        param_dict[key] = value
    return param_dict


def raw_xml_tree(path):
    """ Load raw (no macro expansion) tree representation of XML represented
    at the specified path.
    """
    tree = parse_xml(path, strip_whitespace=False, remove_comments=True)
    return tree


def imported_macro_paths(root):
    macros_el = _macros_el(root)
    return _imported_macro_paths_from_el(macros_el)


def _import_macros(root, path):
    xml_base_dir = os.path.dirname(path)
    macros_el = _macros_el(root)
    if macros_el is not None:
        macro_els, macro_paths = _load_macros(macros_el, xml_base_dir)
        _xml_set_children(macros_el, macro_els)
        return macro_paths


def _macros_el(root):
    return root.find('macros')


def _macros_of_type(root, type, el_func):
    macros_el = root.find('macros')
    macro_dict = {}
    if macros_el is not None:
        macro_els = macros_el.findall('macro')
        filtered_els = [(macro_el.get("name"), el_func(macro_el))
                        for macro_el in macro_els
                        if macro_el.get('type') == type]
        macro_dict = dict(filtered_els)
    return macro_dict


def expand_nested_tokens(tokens):
    for token_name in tokens.keys():
        for current_token_name, current_token_value in tokens.items():
            if token_name in current_token_value:
                if token_name == current_token_name:
                    raise Exception(f"Token '{token_name}' cannot contain itself")
                tokens[current_token_name] = current_token_value.replace(token_name, tokens[token_name])
    return tokens


def _expand_tokens(elements, tokens):
    if not tokens or elements is None:
        return

    for element in elements:
        _expand_tokens_for_el(element, tokens)


def _expand_tokens_for_el(element, tokens):
    value = element.text
    if value:
        new_value = _expand_tokens_str(element.text, tokens)
        if not (new_value is value):
            element.text = new_value
    for key, value in element.attrib.items():
        new_value = _expand_tokens_str(value, tokens)
        if not (new_value is value):
            element.attrib[key] = new_value
    _expand_tokens(list(element), tokens)


def _expand_tokens_str(s, tokens):
    for key, value in tokens.items():
        if key in s:
            s = s.replace(key, value)
    return s


def _expand_macros(elements, macros, tokens):
    if not macros and not tokens:
        return

    for element in elements:
        while True:
            expand_el = element.find('.//expand')
            if expand_el is None:
                break
            _expand_macro(element, expand_el, macros, tokens)


def _expand_macro(element, expand_el, macros, tokens):
    macro_name = expand_el.get('macro')
    assert macro_name is not None, "Attempted to expand macro with no 'macro' attribute defined."
    assert macro_name in macros, f"No macro named {macro_name} found, known macros are {', '.join(macros.keys())}."
    macro_def = macros[macro_name]
    expanded_elements = deepcopy(macro_def.element)
    _expand_yield_statements(expanded_elements, expand_el)

    # Recursively expand contained macros.
    _expand_macros(expanded_elements, macros, tokens)
    macro_tokens = macro_def.macro_tokens(expand_el)
    if macro_tokens:
        _expand_tokens(expanded_elements, macro_tokens)

    _xml_replace(expand_el, expanded_elements)


def _expand_yield_statements(macro_def, expand_el):
    """
    Modifies the macro_def element by replacing all <yield/> tags below the
    macro_def element by the children  of the expand_el

    >>> from lxml.etree import tostring
    >>> from galaxy.util import XML
    >>> expand_el = XML('''
    ...     <expand macro="test">
    ...         <sub_of_expand_1/>
    ...         <sub_of_expand_2/>
    ...     </expand>''')
    >>> macro_def = XML('''
    ... <xml name="test">
    ...     <A><yield/></A>
    ...     <B><yield/></B>
    ... </xml>''')
    >>> _expand_yield_statements(macro_def, expand_el)
    >>> print(tostring(macro_def).decode('UTF-8'))
    <xml name="test">
        <A><sub_of_expand_1/>
            <sub_of_expand_2/>
        </A>
        <B><sub_of_expand_1/>
            <sub_of_expand_2/>
        </B>
    </xml>
    >>> macro_def = XML('''
    ... <xml name="test">
    ...     <blah/>
    ...     <yield/>
    ...     <blah/>
    ...     <yield/>
    ... </xml>''')
    >>> _expand_yield_statements(macro_def, expand_el)
    >>> print(tostring(macro_def).decode('UTF-8'))
    <xml name="test">
        <blah/>
        <sub_of_expand_1/>
            <sub_of_expand_2/>
        <blah/>
        <sub_of_expand_1/>
            <sub_of_expand_2/>
        </xml>
    """
    yield_els = [yield_el for yield_el in macro_def.findall('.//yield')]
    expand_el_children = list(expand_el)
    for yield_el in yield_els:
        _xml_replace(yield_el, expand_el_children)


def _load_macros(macros_el, xml_base_dir):
    macros = []
    # Import macros from external files.
    imported_macros, macro_paths = _load_imported_macros(macros_el, xml_base_dir)
    macros.extend(imported_macros)
    # Load all directly defined macros.
    macros.extend(_load_embedded_macros(macros_el, xml_base_dir))
    return macros, macro_paths


def _load_embedded_macros(macros_el, xml_base_dir):
    macros = []

    macro_els = []
    # attribute typed macro
    if macros_el is not None:
        macro_els = macros_el.findall("macro")
    for macro in macro_els:
        if 'type' not in macro.attrib:
            macro.attrib['type'] = 'xml'
        macros.append(macro)

    # type shortcuts (<xml> is a shortcut for <macro type="xml",
    # likewise for <template>.
    typed_tag = ['template', 'xml', 'token']
    for tag in typed_tag:
        macro_els = []
        if macros_el is not None:
            macro_els = macros_el.findall(tag)
        for macro_el in macro_els:
            macro_el.attrib['type'] = tag
            macro_el.tag = 'macro'
            macros.append(macro_el)

    return macros


def _load_imported_macros(macros_el, xml_base_dir):
    macros = []
    macro_paths = []

    for tool_relative_import_path in _imported_macro_paths_from_el(macros_el):
        import_path = \
            os.path.join(xml_base_dir, tool_relative_import_path)
        macro_paths.append(import_path)
        file_macros, current_macro_paths = _load_macro_file(import_path, xml_base_dir)
        macros.extend(file_macros)
        macro_paths.extend(current_macro_paths)

    return macros, macro_paths


def _imported_macro_paths_from_el(macros_el):
    imported_macro_paths = []
    macro_import_els = []
    if macros_el is not None:
        macro_import_els = macros_el.findall("import")
    for macro_import_el in macro_import_els:
        raw_import_path = macro_import_el.text
        imported_macro_paths.append(raw_import_path)
    return imported_macro_paths


def _load_macro_file(path, xml_base_dir):
    tree = parse_xml(path, strip_whitespace=False)
    root = tree.getroot()
    return _load_macros(root, xml_base_dir)


def _xml_set_children(element, new_children):
    for old_child in element:
        element.remove(old_child)
    for i, new_child in enumerate(new_children):
        element.insert(i, new_child)


def _xml_replace(query, targets):
    parent_el = query.find('..')
    matching_index = -1
    # for index, el in enumerate(parent_el.iter('.')):  ## Something like this for newer implementation
    for index, el in enumerate(list(parent_el)):
        if el == query:
            matching_index = index
            break
    assert matching_index >= 0
    current_index = matching_index
    for target in targets:
        current_index += 1
        parent_el.insert(current_index, deepcopy(target))
    parent_el.remove(query)


class XmlMacroDef:
    """
    representation of a (Galaxy) XML macro

    stores the root element of the macro and the parameters.
    each parameter is represented as pair containing
    - the quote character, default '@'
    - parameter name

    parameter names can be given as comma separated list using the
    `token` attribute or as attributes `token_XXX` (where `XXX` is the name).
    The former option should be used to specify required attributes of the
    macro and the latter for optional attributes if the macro (the value of
    `token_XXX is used as default value).

    TODO: `token_quote` forbids `"quote"` as character name of optional
    parameters
    """
    def __init__(self, el):
        self.element = el
        parameters = {}
        tokens = []
        token_quote = el.attrib.get("token_quote", "@")
        for key, value in el.attrib.items():
            if key == "tokens":
                for token in value.split(","):
                    tokens.append((token, REQUIRED_PARAMETER))
            elif key.startswith("token_"):
                token = key[len("token_"):]
                tokens.append((token, value))
        for name, default in tokens:
            parameters[name] = (token_quote, default)
        self.parameters = parameters

    def macro_tokens(self, expand_el):
        """
        get a dictionary mapping token names to values. The names are the
        parameter names surrounded by the quote character. Values are taken
        from the expand_el if absent default values of optional parameters are
        used.
        """
        tokens = {}
        for key, (wrap_char, default_val) in self.parameters.items():
            token_value = expand_el.attrib.get(key, default_val)
            if token_value is REQUIRED_PARAMETER:
                raise ValueError(f"Failed to expand macro - missing required parameter [{key}].")
            token_name = f"{wrap_char}{key.upper()}{wrap_char}"
            tokens[token_name] = token_value
        return tokens


__all__ = (
    "imported_macro_paths",
    "load",
    "load_with_references",
    "raw_xml_tree",
    "template_macro_params",
)
